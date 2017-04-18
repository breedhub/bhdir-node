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

        this.indexes = new Map();

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

        return Promise.resolve()
            .then(() => {
                for (let [ folder, info ] of this._directory.folders) {
                    this.indexes.set(
                        folder,
                        {
                            enabled: info.enabled,
                            dataDir: info.dataDir,
                            dirMode: info.dirMode,
                            fileMode: info.fileMode,
                            uid: info.uid,
                            gid: info.gid,
                            tree: new AVLTree({ unique: true, compareKeys: this.constructor.compareKeys }),
                            confirmation: new Map(),
                            needSave: false,
                            needLoad: false,
                            saving: false,
                            loading: false,
                        }
                    );
                }
            });
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
     * @param {string} folder                   Folder name
     * @return {Promise}
     */
    build(folder) {
        let info = this.indexes.get(folder);
        if (!info || !info.enabled)
            return Promise.reject(new Error(`Unknown folder or folder is disabled: ${folder}`));

        this._logger.debug('index', `Building index of ${folder}`);

        let tree = new AVLTree({ unique: true, compareKeys: this.constructor.compareKeys });
        let messages = [];
        return this._loadDir(info.dataDir, '/', tree, messages)
            .then(() => {
                info.tree = tree;
                return this.save(folder);
            })
            .then(() => {
                return messages;
            });
    }

    /**
     * Save index
     * @param {string} folder                   Folder name
     * @return {Promise}
     */
    save(folder) {
        let info = this.indexes.get(folder);
        if (!info || !info.enabled)
            return Promise.reject(new Error(`Unknown folder or folder is disabled: ${folder}`));

        if (info.loading || info.saving)
            return Promise.resolve();

        if (!info.tree.tree.data.length)
            return Promise.resolve();

        this._logger.debug('index', `Saving index of ${folder}`);
        info.saving = true;
        info.needSave = false;

        let hash, tree;
        try {
            hash = crypto.createHash('md5');
            tree = this._serialize(info.tree.tree);
            hash.update(tree);
        } catch (error) {
            info.saving = false;
            return Promise.reject(new WError(error, `Index.save(): ${folder}`));
        }

        return this._filer.lockWriteBuffer(
                path.join(info.dataDir, '.index.1'),
                Buffer.concat([ hash.digest(), tree ]),
                { mode: info.fileMode, uid: info.uid, gid: info.gid }
            )
            .then(
                () => {
                    info.saving = false;
                    if (info.needSave)
                        return this.save(folder);
                },
                error => {
                    info.saving = false;
                    throw error;
                }
            );
    }

    /**
     * Load index
     * @param {string} folder                   Folder name
     * @return {Promise}
     */
    load(folder) {
        let info = this.indexes.get(folder);
        if (!info || !info.enabled)
            return Promise.reject(new Error(`Unknown folder or folder is disabled: ${folder}`));

        if (info.loading || info.saving)
            return Promise.resolve();

        this._logger.debug('index', `Loading index of ${folder}`);
        info.loading = true;
        info.needLoad = false;

        return this._filer.lockReadBuffer(path.join(info.dataDir, '.index.1'))
            .then(buffer => {
                let hashBuffer = buffer.slice(0, 16);
                let treeBuffer = buffer.slice(16);

                let hash = crypto.createHash('md5');
                hash.update(treeBuffer);
                if (!hashBuffer.equals(hash.digest()))
                    throw new Error(`Index of ${folder} has wrong checksum`);

                let node = this._deserialize({ tree: info.tree, buffer: treeBuffer, offset: 0 }, null);
                if (node)
                    info.tree.tree = node;

                for (let [ id, confirm ] of info.confirmation) {
                    let search = info.tree.search(id);
                    if (search.length) {
                        if (++confirm.counter >= 3) {
                            this._logger.debug('index', `Id ${id} confirmed`);
                            info.confirmation.delete(id);
                        }
                    } else {
                        confirm.counter = 0;
                        this._logger.debug('index', `Id ${id} is missing from index of ${folder}`);
                        this.insert(confirm.type, id, confirm.record);
                    }
                }
            })
            .then(
                () => {
                    info.loading = false;
                    if (info.needLoad)
                        return this.load(folder);
                },
                error => {
                    info.loading = false;
                    if (error.code === 'ENOENT') {
                        info.tree = new AVLTree({ unique: true, compareKeys: this.constructor.compareKeys });
                        return;
                    }
                    throw error;
                }
            )
            .catch(error => {
                throw new WError(error, `Index.load(): ${folder}`);
            });
    }

    /**
     * Find ID
     * @param {bignum} id                       ID
     * @return {object}
     */
    search(id) {
        this._logger.debug('index', `Searching for ${id}`);

        for (let [ folder, info ] of this.indexes) {
            let search = info.tree.search(id);
            if (!search.length)
                continue;
            if (!search[0])
                return null;

            if (!search[0].data)
                search[0].data = JSON.parse(search[0].buffer);
            return Object.assign({ folder: folder }, search[0].data);
        }

        return null;
    }

    /**
     * Insert index entry
     * @param {string} type                     Type of entry
     * @param {bignum} id                       ID
     * @param {object} record                   Description
     */
    insert(type, id, record) {
        let info = this.indexes.get(record.folder);
        if (!info || !info.enabled)
            return Promise.reject(new Error(`Unknown folder or folder is disabled: ${record.folder}`));

        if (info.tree.search(id).length)
            return Promise.resolve();

        this._logger.debug('index', `Inserting ${type} of ${record.folder}:${record.path} as ${id}`);
        let data;
        switch (type) {
            case 'variable':
                data = {
                    type: type,
                    path: record.path,
                };
                break;
            case 'history':
                data = {
                    type: type,
                    path: record.path,
                    attr: record.attr,
                };
                break;
            case 'file':
                data = {
                    type: type,
                    path: record.path,
                    attr: record.attr,
                    bin: record.bin,
                };
                break;
            default:
                throw new Error(`Invalid type: ${type}`);
        }
        info.tree.insert(id, {
            buffer: null,
            data: data,
        });
        info.needSave = true;

        let confirm = info.confirmation.get(id);
        if (!confirm) {
            confirm = {
                counter: 0,
                type: type,
                record: record,
            };
            info.confirmation.set(id, confirm);
        }
    }

    /**
     * Delete ID
     * @param {bignum} id                       ID
     */
    del(id) {
        for (let [ folder, info ] of this.indexes) {
            let search = info.tree.search(id);
            if (search.length) {
                this._logger.debug('index', `Deleting ${id}`);
                info.tree.delete(id);
                info.needSave = true;
                return;
            }
        }
    }

    /**
     * Save the trees
     */
    onSaveTimer() {
        for (let [ folder, info ] of this.indexes) {
            if (!info.needSave)
                continue;

            this.save(folder)
                .catch(error => {
                    this._logger.error(error);
                });
        }
    }

    /**
     * Serialize tree node
     * @param {object} node
     * @return {Buffer}
     */
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

    /**
     * Deserialize next tree node
     * @param {object} info
     * @param {object} parent
     * @return {object}
     */
    _deserialize(info, parent) {
        let id = info.buffer.slice(info.offset, info.offset + 16);
        info.offset += 16;
        if (id.equals(this.constructor.nullId))
            return null;

        let node = info.tree.tree.createSimilar();

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

    /**
     * Index directory
     * @param {string} root
     * @param {string} dir
     * @param {object} tree
     * @param {string[]} messages
     * @return {Promise}
     */
    _loadDir(root, dir, tree, messages) {
        return new Promise((resolve, reject) => {
                fs.readdir(path.join(root, dir), (error, files) => {
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
                            fs.stat(path.join(root, dir, file), (error, stats) => {
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
                        let re = /^(\d+)\.json$/;
                        for (let i = 0; i < files.length; i++) {
                            if (stats[i].isDirectory()) {
                                promises.push(this._loadDir(root, path.join(dir, files[i]), tree, messages));
                            } else if (files[i] === '.vars.json') {
                                promises.push(
                                    this._filer.lockRead(path.join(root, dir, files[i]))
                                        .then(contents => {
                                            let json;
                                            try {
                                                json = JSON.parse(contents);
                                            } catch (error) {
                                                return messages.push(`Could not read ${path.join(root, dir, files[i])}`);
                                            }

                                            for (let key of Object.keys(json)) {
                                                if (!json[key])
                                                    continue;
                                                let varId = json[key]['id'];
                                                if (!this._util.isUuid(varId))
                                                    continue;

                                                let varName = path.join(dir, key);
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
                                if ((end = dir.indexOf('/.history/')) !== -1) {
                                    promises.push(
                                        this._filer.lockRead(path.join(root, dir, files[i]))
                                            .then(contents => {
                                                let json;
                                                try {
                                                    json = JSON.parse(contents);
                                                } catch (error) {
                                                    return messages.push(`Could not read ${path.join(root, dir, files[i])}`);
                                                }

                                                let historyId = json['id'];
                                                if (!this._util.isUuid(historyId))
                                                    return;

                                                tree.insert(this.constructor.binUuid(historyId), {
                                                    buffer: null,
                                                    data: {
                                                        type: 'history',
                                                        path: dir.substring(0, end),
                                                        attr: path.join(dir, files[i]),
                                                    }
                                                });
                                            })
                                    );
                                } else if ((end = dir.indexOf('/.files/')) !== -1) {
                                        promises.push(
                                            this._filer.lockRead(path.join(root, dir, files[i]))
                                                .then(contents => {
                                                    let json;
                                                    try {
                                                        json = JSON.parse(contents);
                                                    } catch (error) {
                                                        return messages.push(`Could not read ${path.join(root, dir, files[i])}`);
                                                    }

                                                    let fileId = json['id'];
                                                    if (!this._util.isUuid(fileId))
                                                        return;

                                                    tree.insert(this.constructor.binUuid(fileId), {
                                                        buffer: null,
                                                        data: {
                                                            type: 'file',
                                                            path: dir.substring(0, end),
                                                            attr: path.join(dir, files[i]),
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

    /**
     * In order iteration
     * @param {object} node
     * @return {string}
     */
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
