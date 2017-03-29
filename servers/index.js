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

        this.tree = null;

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
                return messages;
            });
    }

    save() {
        if (!this.tree || !this.tree.tree.data.length)
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

    _serialize(node) {
        if (!node)
            return Buffer.alloc(17, 0);

        let buffer = node.key.toBuffer();
        if (buffer.length !== 16)
            throw new Error(`Invalid ID size: ${buffer.length}`);
        if (node.data.length !== 1)
            throw new Error(`Invalid data size: ${node.data.length}`);

        let json = JSON.stringify(node.data[0]);
        return Buffer.concat([ buffer, Buffer.from(json), Buffer.alloc(1, 0), this._serialize(node.left), this._serialize(node.right) ]);
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
                                                tree.insert(this._binUuid(varId), {
                                                    type: 'var',
                                                    path: varName,
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

    _binUuid(id) {
        return bignum.fromBuffer(Buffer.from(id.replace(/-/g, ''), 'hex'));
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
