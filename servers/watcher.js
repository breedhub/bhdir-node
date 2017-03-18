/**
 * Sync directory watcher
 * @module servers/watcher
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const ini = require('ini');
const EventEmitter = require('events');
const WError = require('verror').WError;

/**
 * Server class
 */
class Watcher extends EventEmitter {
    /**
     * Create the service
     * @param {App} app                             Application
     * @param {object} config                       Configuration
     * @param {Logger} logger                       Logger service
     * @param {Filer} filer                         Filer service
     * @param {Cacher} cacher                       Cacher service
     * @param {Util} util                           Util service
     */
    constructor(app, config, logger, filer, cacher, util) {
        super();

        this.sessionId = util.getRandomString(8, { lower: true, upper: true, digits: true, special: false });
        this.updates = new Map();
        this.rootWatcher = null;
        this.updatesWatcher = null;
        this.watchedFiles = new Map();

        this._name = null;
        this._app = app;
        this._config = config;
        this._logger = logger;
        this._filer = filer;
        this._cacher = cacher;
        this._util = util;
    }

    /**
     * Service name is 'servers.watcher'
     * @type {string}
     */
    static get provides() {
        return 'servers.watcher';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'logger', 'filer', 'cacher', 'util' ];
    }

    /**
     * Update entry lifetime
     */
    static get updatesLifetime() {
        return 10 * 60 * 1000; // ms
    }

    /**
     * Clean updates directory interval
     */
    static get cleanUpdatesInterval() {
        return 10 * 1000; // ms
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
                (prev, [ curName, curModule ]) => {
                    return prev.then(() => {
                        if (!curModule.register)
                            return;

                        let result = curModule.register(name);
                        if (result === null || typeof result != 'object' || typeof result.then != 'function')
                            throw new Error(`Module '${curName}' register() did not return a Promise`);
                        return result;
                    });
                },
                Promise.resolve()
            )
            .then(() => {
                this._logger.debug('watcher', 'Starting the server');

                this._logger.debug('watcher', `Watching ${this._directory.rootDir}`);
                this.rootWatcher = fs.watch(this._directory.rootDir, this.onChangeRoot.bind(this));
                if (!this.rootWatcher)
                    throw new Error('Could not install root watcher');

                this.rootWatcher.on('error', this.onErrorRoot.bind(this));

                this._watchUpdates();

                let files, updatesPath = path.join(this._directory.rootDir, 'updates');
                try {
                    files = fs.readdirSync(updatesPath);
                } catch (error) {
                    // do nothing
                }

                if (files) {
                    return files.reduce(
                        (prev, file) => {
                            return prev.then(() => {
                                let json = { timestamp: Date.now() };
                                this.updates.set(file, json);
                            });
                        },
                        Promise.resolve()
                    );
                }
            })
            .then(() => {
                this._cleanUpdatesTimer = setInterval(this.onCleanUpdates.bind(this), this.constructor.cleanUpdatesInterval);
            });
    }

    /**
     * Try reading JSON file until its written if it exists
     * @param {string} filename                         Name of the file
     * @return {Promise}
     */
    readJson(filename) {
        return this._addJsonFile(filename);
    }

    /**
     * Try updating JSON file after it has been written if it exists, otherwise create
     * @param {string} filename                         Name of the file
     * @param {Function} cb                             Update callback
     * @return {Promise}
     */
    updateJson(filename, cb) {
        return this._addJsonFile(filename, cb);
    }

    /**
     * Root directory changed
     * @param {string} eventType                        Either 'rename' or 'change'
     * @param {string} [filename]                       Name of the file
     */
    onChangeRoot(eventType, filename) {
        this._logger.debug('watcher', `Root event: ${eventType}, ${filename}`);
        this._watchUpdates();
    }

    /**
     * Root directory watcher error
     * @param {Error} error                             Error object
     */
    onErrorRoot(error) {
        this._logger.error(`Root directory error: ${error.message}`);
    }

    /**
     * Updates directory changed
     * @param {string} eventType                        Either 'rename' or 'change'
     * @param {string} [filename]                       Name of the file
     */
    onChangeUpdates(eventType, filename) {
        this._logger.debug('watcher', `Updates event: ${eventType}, ${filename}`);

        let files, updatesPath = path.join(this._directory.rootDir, 'updates');
        try {
            files = fs.readdirSync(updatesPath);
        } catch (error) {
            return;
        }

        for (let file of files) {
            if (this.updates.has(file))
                continue;

            this.updates.set(file, {
                timestamp: Date.now(),
            });

            let parts = file.split('.');
            if (parts.length != 3 || parts[1] == this.sessionId)
                continue;

            this.readJson(path.join(updatesPath, file))
                .then(json => {
                    for (let path of json.paths) {
                        this._logger.debug('watcher', `Path updated: ${path}`);
                        this._cacher.unset(path)
                            .then(
                                () => {
                                    this._directory.notify(path);
                                },
                                error => {
                                    this._directory.notify(path);
                                    this._logger.error(new WError(error, 'Watcher.onChangeUpdates(): unset'));
                                }
                            );
                    }
                })
                .catch(error => {
                    this._logger.error(`Update read error: ${error.message}`);
                });
        }
    }

    /**
     * Updates directory watcher error
     * @param {Error} error                             Error object
     */
    onErrorUpdates(error) {
        this._logger.error(`Updates directory error: ${error.message}`);
    }

    /**
     * Delete expired updates
     */
    onCleanUpdates() {
        let updatesPath = path.join(this._directory.rootDir, 'updates');
        let expiration = Date.now() - this.constructor.updatesLifetime;
        for (let [ name, info ] of this.updates) {
            if (info.timestamp < expiration) {
                this._logger.debug('watcher', `Update expired: ${name}`);
                try {
                    fs.unlinkSync(path.join(updatesPath, name));
                } catch (error) {
                    // do nothing
                }
                this.updates.delete(name);
            }
        }
    }

    /**
     * Create and watch updates directory
     */
    _watchUpdates() {
        let updates, updatesPath = path.join(this._directory.rootDir, 'updates');
        try {
            fs.accessSync(updatesPath, fs.constants.F_OK);
            updates = true;
        } catch (error) {
            updates = false;
        }

        if (this.updatesWatcher) {
            if (!updates) {
                this.updatesWatcher.close();
                this.updatesWatcher = null;
            }
            return;
        }

        try {
            if (!updates)
                return;

            this._logger.debug('watcher', `Watching ${updatesPath}`);
            this.updatesWatcher = fs.watch(updatesPath, this.onChangeUpdates.bind(this));
            if (!this.updatesWatcher)
                throw new Error('Could not install updates watcher');

            this.updatesWatcher.on('error', this.onErrorUpdates.bind(this));
            this._logger.info('Watcher installed');
        } catch (error) {
            this._logger.error(new WError(error, 'Watcher._watchUpdates'));
        }
    }

    _addJsonFile(filename, cb) {
        return new Promise((resolve, reject) => {
            let info = this.watchedFiles.get(filename);
            if (!info) {
                info = {
                    timestamp: Date.now(),
                    watch: null,
                    process: [],
                    success: [],
                    error: [],
                };

                this.watchedFiles.set(filename, info);
            }

            let exists;
            try {
                fs.accessSync(filename, fs.constants.F_OK);
                exists = true;
            } catch (error) {
                exists = false;
            }

            if (exists) {
                info.watch = fs.watch(filename, (eventType, name) => {
                    this._logger.debug('watcher', `JSON ${filename} event: ${eventType}, ${name}`);
                    this._processJsonFile(filename);
                });
                if (!info.watch)
                    return reject(new Error('Could not install updates watcher'));
                info.watch.on('error', error => {
                    this._logger.error(`JSON ${filename} error: ${error.message}`);
                });
            }

            if (cb)
                info.process.push(cb);
            info.success.push(resolve);
            info.error.push(reject);

            this._processJsonFile(filename);
        });
    }

    _processJsonFile(filename) {
        let info = this.watchedFiles.get(filename);
        if (!info)
            return;

        let complete = (json, error) => {
            if (json) {
                for (let cb of info.process)
                    json = cb(json);
                for (let cb of info.success)
                    cb(json);
            } else {
                for (let cb of info.error)
                    cb(error);
            }

            if (info.watch)
                info.watch.close();

            this.watchedFiles.delete(filename);
            return json;
        };

        if (!info.process.length) {
            if (!info.watch)
                return complete({}, null);

            return this._filer.lockRead(filename)
                .then(contents => {
                    let again = this.watchedFiles.get(filename);
                    if (!again || again != info)
                        return;
                    if (again.process.length)
                        return this._processJsonFile(filename);

                    let json;
                    try {
                        json = JSON.parse(contents);
                    } catch (error) {
                        this._logger.debug('watcher', `Premature read of ${filename}`);
                        return;
                    }

                    complete(json, null);
                })
                .catch(error => {
                    let again = this.watchedFiles.get(filename);
                    if (!again || again != info)
                        return;
                    if (again.process.length)
                        return this._processJsonFile(filename);

                    complete(null, error);
                });
        }

        return this._filer.lockUpdate(
                filename,
                contents => {
                    let again = this.watchedFiles.get(filename);
                    if (!again || again != info)
                        return Promise.resolve(contents);

                    let json;
                    try {
                        json = JSON.parse(contents);
                    } catch (error) {
                        if (info.watch) {
                            this._logger.debug('watcher', `Premature read of ${filename}`);
                            return Promise.resolve(contents);
                        } else {
                            json = {};
                        }
                    }

                    json = complete(json, null);
                    return Promise.resolve(JSON.stringify(json, undefined, 4));
                },
                { mode: this._directory.dirMode, uid: this._directory.user, gid: this._directory.group }
            )
            .catch(error => {
                let again = this.watchedFiles.get(filename);
                if (!again || again != info)
                    return;

                complete(null, error);
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

module.exports = Watcher;
