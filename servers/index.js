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
        let tree = new AVLTree({ unique: true, compareKeys: this.constructor.compareKeys });
        let messages = [];
        return this._loadDir(this._directory.dataDir, tree, messages)
            .then(() => {
                this.tree = tree;
                return this.save();
            })
            .then(() => {
                return this.load();
            })
            .then(() => {
                return messages;
            });
    }

    save() {
        if (!this.tree.tree.data.length)
            return Promise.resolve();

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
        return this._filer.lockReadBuffer(path.join(this._directory.dataDir, '.index.1'))
            .then(buffer => {
                let hashBuffer = buffer.slice(0, 16);
                let treeBuffer = buffer.slice(16);

                let hash = crypto.createHash('md5');
                hash.update(treeBuffer);
                if (!hashBuffer.equals(hash.digest()))
                    throw new Error('Index has wrong checksum');

                let node = this._deserialize({ buffer: buffer, offset: 0 });
                if (node) {
                    this.tree = new AVLTree({ unique: true, compareKeys: this.constructor.compareKeys });
                    this.tree.tree = node;
                }
            });
    }

    search(id) {
        if (!this.tree)
            return null;

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

        this._logger.debug('index', `Inserting ${type} of ${info.path}`);
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
                        attr: info.history,
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

    delete(id) {
        let search = this.tree.search(id);
        if (search.length) {
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
                },
                error => {
                    this._saving = false;
                    this._logger.error(error);
                }
            );
    }

    _serialize(node) {
        if (!node)
            return Buffer.alloc(16, 0);

        let buffer = node.key.toBuffer();
        if (buffer.length !== 16)
            throw new Error(`Invalid ID size: ${buffer.length}`);
        if (node.data.length !== 1)
            throw new Error(`Invalid data size: ${node.data.length}`);

        if (!node.data[0].buffer)
            node.data[0].buffer = Buffer.from(JSON.stringify(node.data[0].data));

        return Buffer.concat([ buffer, node.data[0].buffer, Buffer.alloc(1, 0), this._serialize(node.left), this._serialize(node.right) ]);
    }

    _deserialize(info) {
        let id = info.buffer.slice(info.offset, info.offset + 16);
        if (id.equals(this.constructor.nullId))
            return null;

        let ClassFunc = this.tree.tree.constructor;
        let node = new ClassFunc({ unique: true, compareKeys: this.constructor.compareKeys });

        info.offset += 16;
        let start = info.offset;
        while (true) {
            if (info.offset >= info.buffer.length)
                throw new Error('Index is truncated');

            if (info.buffer[info.offset++] === 0)
                break;
        }

        node.key = bignum.fromBuffer(id);
        node.data = { buffer: info.buffer.slice(start, info.offset - 1), data: null };
        let left = this._deserialize(info);
        if (left)
            node.left = left;
        let right = this._deserialize(info);
        if (right)
            node.right = right;

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
                                                let varId = json[key]['id'];
                                                if (!this._util.isUuid(varId))
                                                    continue;
                                                let varName = path.join(directory, key);
                                                tree.insert(this.constructor.binUuid(varId), {
                                                    buffer: null,
                                                    data: {
                                                        type: 'var',
                                                        path: varName,
                                                    }
                                                });
                                            }
                                        })
                                );
                            }
                        }

                        if (promises.length)
                            return Promise.all(promises);
                    });
            });
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
