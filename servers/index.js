/**
 * Directory index
 * @module servers/index
 */
const path = require('path');
const fs = require('fs');
const uuid = require('uuid');
const bignum = require('bignum');
const crypto = require('crypto');
const EventEmitter = require('events');
const AVLTree = require('binary-search-tree').AVLTree;
const WError = require('verror').WError;

/**
 * Server class
 */
class Index extends EventEmitter {
    /**
     * Create the service
     * @param {App} app                             Application
     * @param {object} config                       Configuration
     * @param {Logger} logger                       Logger service
     * @param {Filer} filer                         Filer service
     * @param {Util} util                           Util service
     */
    constructor(app, config, logger, filer, util) {
        super();

        this.tree = new AVLTree({ unique: true, compareKeys: this.constructor.compareKeys });
        this.needSave = false;

        this._saving = false;

        this._name = null;
        this._app = app;
        this._config = config;
        this._logger = logger;
        this._filer = filer;
        this._util = util;
    }

    /**
     * Service name is 'servers.index'
     * @type {string}
     */
    static get provides() {
        return 'servers.index';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'logger', 'filer', 'util' ];
    }

    static get nullId() {
        return Buffer.alloc(16, 0);
    }

    static binUuid(id) {
        return bignum.fromBuffer(Buffer.from(id.replace(/-/g, ''), 'hex'));
    }

    static compareKeys(a, b) {
        return a.cmp(b);
    }

    /**
     * Initialize the server
     * @param {string} name                     Config section name
     * @return {Promise}
     */
    init(name) {
        this._name = name;

        return Promise.resolve();
    }

    /**
     * Start the server
     * @param {string} name                     Config section name
     * @return {Promise}
     */
    start(name) {
        if (name !== this._name)
            return Promise.reject(new Error(`Server ${name} was not properly initialized`));

        return Array.from(this._app.get('modules')).reduce(
            (prev, [curName, curModule]) => {
                return prev.then(() => {
                    if (!curModule.register)
                        return;

                    let result = curModule.register(name);
                    if (result === null || typeof result !== 'object' || typeof result.then !== 'function')
                        throw new Error(`Module '${curName}' register() did not return a Promise`);
                    return result;
                });
            },
            Promise.resolve()
            )
            .then(() => {
                this._logger.debug('index', 'Starting the server');
                this._saveTimer = setInterval(this.onSaveTimer.bind(this), 1000);
            });
    }

    /**
     * Build index
     * @return {Promise}
     */
    build() {
        this._logger.debug('index', 'Building index');

        let tree = new AVLTree({ unique: true, compareKeys: this.constructor.compareKeys });
        let messages = [];
        return this._loadDir(this._directory.dataDir, tree, messages)
            .then(() => {
                this.tree = tree;
                return this.save();
            })
            .then(() => {
                return messages;
            });
    }

    save() {
        if (!this.tree.tree.data.length)
            return Promise.resolve();

        this._logger.debug('index', 'Saving index');

        let hash, tree;
        try {
            hash = crypto.createHash('md5');
            tree = this._serialize(this.tree.tree);
            hash.update(tree);
        } catch (error) {
            return Promise.reject(error);
        }

        return this._filer.lockWriteBuffer(
            path.join(this._directory.dataDir, '.index.1'),
            Buffer.concat([ hash.digest(), tree ]),
            { mode: this._directory.fileMode, uid: this._directory.user, gid: this._directory.group }
        );
    }

    load() {
        this._logger.debug('index', 'Loading index');

        return this._filer.lockReadBuffer(path.join(this._directory.dataDir, '.index.1'))
            .then(buffer => {
                let hashBuffer = buffer.slice(0, 16);
                let treeBuffer = buffer.slice(16);

                let hash = crypto.createHash('md5');
                hash.update(treeBuffer);
                if (!hashBuffer.equals(hash.digest()))
                    throw new Error('Index has wrong checksum');

                let node = this._deserialize({ buffer: treeBuffer, offset: 0 }, null);
                if (node)
                    this.tree.tree = node;
            });
    }

    search(id) {
        this._logger.debug('index', `Searching for ${id}`);

        let search = this.tree.search(id);
        let result = search.length ? search[0] : null;
        if (!result)
            return result;

        if (!result.data)
            result.data = JSON.parse(result.buffer);
        return result.data;
    }

    insert(type, id, info) {
        if (this.tree.search(id).length)
            return;

        this._logger.debug('index', `Inserting ${type} of ${info.path} as ${id}`);
        switch (type) {
            case 'variable':
                this.tree.insert(id, {
                    buffer: null,
                    data: {
                        type: type,
                        path: info.path,
                    }
                });
                break;
            case 'history':
                this.tree.insert(id, {
                    buffer: null,
                    data: {
                        type: type,
                        path: info.path,
                        attr: info.attr,
                    }
                });
                break;
            case 'file':
                this.tree.insert(id, {
                    buffer: null,
                    data: {
                        type: type,
                        path: info.path,
                        attr: info.attr,
                        bin: info.bin,
                    }
                });
                break;
            default:
                throw new Error(`Invalid type: ${type}`);
        }
        this.needSave = true;
    }

    del(id) {
        let search = this.tree.search(id);
        if (search.length) {
            this._logger.debug('index', `Deleting ${id}`);
            this.tree.delete(id);
            this.needSave = true;
        }
    }

    onSaveTimer() {
        if (this._saving || !this.needSave)
            return;

        this._saving = true;
        this.save()
            .then(
                () => {
                    this._saving = false;
                    this.needSave = false;
                },
                error => {
                    this._saving = false;
                    this._logger.error(error);
                }
            );
    }

    _serialize(node) {
        if (!node)
            return this.constructor.nullId;

        let buffer = node.key.toBuffer();
        if (buffer.length !== 16)
            throw new Error(`Invalid ID size: ${buffer.length}`);
        if (node.data.length !== 1)
            throw new Error(`Invalid data size: ${node.data.length}`);

        if (!node.data[0].buffer)
            node.data[0].buffer = Buffer.from(JSON.stringify(node.data[0].data));

        return Buffer.concat([ buffer, node.data[0].buffer, Buffer.alloc(1, 0), this._serialize(node.left), this._serialize(node.right) ]);
    }

    _deserialize(info, parent) {
        let id = info.buffer.slice(info.offset, info.offset + 16);
        info.offset += 16;
        if (id.equals(this.constructor.nullId))
            return null;

        let node = this.tree.tree.createSimilar();

        let start = info.offset;
        while (true) {
            if (info.offset >= info.buffer.length)
                throw new Error('Index is truncated');

            if (info.buffer[info.offset++] === 0)
                break;
        }

        node.key = bignum.fromBuffer(id);
        node.data = [ { buffer: info.buffer.slice(start, info.offset - 1), data: null } ];
        node.parent = parent;

        node.left = this._deserialize(info, node);
        node.right = this._deserialize(info, node);

        return node;
    }

    _loadDir(dir, tree, messages) {
        return new Promise((resolve, reject) => {
                fs.readdir(dir, (error, files) => {
                    if (error)
                        return reject(error);

                    resolve(files);
                });
            })
            .then(files => {
                let promises = [];
                for (let file of files) {
                    promises.push(
                        new Promise((resolveStats, rejectStats) => {
                            fs.stat(path.join(dir, file), (error, stats) => {
                                if (error)
                                    return rejectStats(error);

                                resolveStats(stats);
                            });
                        })
                    );
                }

                if (!promises.length)
                    return;

                return Promise.all(promises)
                    .then(stats => {
                        promises = [];
                        let directory = dir.substring(this._directory.dataDir.length) || '/';
                        let re = /^(\d+)\.json$/;
                        for (let i = 0; i < files.length; i++) {
                            if (stats[i].isDirectory()) {
                                promises.push(this._loadDir(path.join(dir, files[i]), tree, messages));
                            } else if (files[i] === '.vars.json') {
                                promises.push(
                                    this._filer.lockRead(path.join(dir, files[i]))
                                        .then(contents => {
                                            let json;
                                            try {
                                                json = JSON.parse(contents);
                                            } catch (error) {
                                                return messages.push(`Could not read ${path.join(dir, files[i])}`);
                                            }

                                            for (let key of Object.keys(json)) {
                                                if (!json[key])
                                                    continue;
                                                let varId = json[key]['id'];
                                                if (!this._util.isUuid(varId))
                                                    continue;

                                                let varName = path.join(directory, key);
                                                tree.insert(this.constructor.binUuid(varId), {
                                                    buffer: null,
                                                    data: {
                                                        type: 'variable',
                                                        path: varName,
                                                    }
                                                });
                                            }
                                        })
                                );
                            } else if (re.test(files[i])) {
                                let end;
                                if ((end = directory.indexOf('/.history/')) !== -1) {
                                    promises.push(
                                        this._filer.lockRead(path.join(dir, files[i]))
                                            .then(contents => {
                                                let json;
                                                try {
                                                    json = JSON.parse(contents);
                                                } catch (error) {
                                                    return messages.push(`Could not read ${path.join(dir, files[i])}`);
                                                }

                                                let historyId = json['id'];
                                                if (!this._util.isUuid(historyId))
                                                    return;

                                                tree.insert(this.constructor.binUuid(historyId), {
                                                    buffer: null,
                                                    data: {
                                                        type: 'history',
                                                        path: directory.substring(0, end),
                                                        attr: path.join(directory, files[i]),
                                                    }
                                                });
                                            })
                                    );
                                } else if ((end = directory.indexOf('/.files/')) !== -1) {
                                        promises.push(
                                            this._filer.lockRead(path.join(dir, files[i]))
                                                .then(contents => {
                                                    let json;
                                                    try {
                                                        json = JSON.parse(contents);
                                                    } catch (error) {
                                                        return messages.push(`Could not read ${path.join(dir, files[i])}`);
                                                    }

                                                    let fileId = json['id'];
                                                    if (!this._util.isUuid(fileId))
                                                        return;

                                                    tree.insert(this.constructor.binUuid(fileId), {
                                                        buffer: null,
                                                        data: {
                                                            type: 'file',
                                                            path: directory.substring(0, end),
                                                            attr: path.join(directory, files[i]),
                                                            bin: json['bin'],
                                                        }
                                                    });
                                                })
                                        );
                                }
                            }
                        }

                        if (promises.length)
                            return Promise.all(promises);
                    });
            });
    }

    _inOrder(node) {
        if (!node)
            return '';

        return this._inOrder(node.left) + node.key + ' ' + this._inOrder(node.right);
    }

    /**
     * Retrieve directory server
     * @return {Directory}
     */
    get _directory() {
        if (this._directory_instance)
            return this._directory_instance;
        this._directory_instance = this._app.get('servers').get('directory');
        return this._directory_instance;
    }
}

module.exports = Index;
