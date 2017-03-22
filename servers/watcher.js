/**
 * Sync directory watcher
 * @module servers/watcher
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const ini = require('ini');
const uuid = require('uuid');
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

        this.sessionId = uuid.v1();
        this.rootWatcher = null;
        this.updatesWatcher = null;
        this.watchedUpdates = new Map();
        this.watchedVarFiles = new Map();

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
     * Watch updates this long after last update
     * @type {number}
     */
    static get watchedPeriod() {
        return 10 * 60 * 1000; // ms
    }

    /**
     * Clean updates directory interval
     * @type {number}
     */
    static get cleanWatchedInterval() {
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
                        if (result === null || typeof result !== 'object' || typeof result.then !== 'function')
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
            })
            .then(() => {
                this._watchedTimer = setInterval(this.onWatchedTimer.bind(this), this.constructor.cleanWatchedInterval);
            });
    }

    /**
     * Try reading JSON file until its written if it exists
     * @param {string} filename                         Name of the file
     * @return {Promise}
     */
    readJson(filename) {
        let parts = filename.split('/');
        parts.pop();
        let directory = parts.join('/');
        let varsFile = path.join(directory, '.vars.json');

        return new Promise((resolve, reject) => {
            this._addJsonFile(this.watchedVarFiles, varsFile, 0, false, null, resolve, reject);
        });
    }

    /**
     * Try updating JSON file after it has been written if it exists, otherwise create
     * @param {string} filename                         Name of the file
     * @param {Function} cb                             Update callback
     * @return {Promise}
     */
    updateJson(filename, cb) {
        let parts = filename.split('/');
        parts.pop();
        let directory = parts.join('/');
        let varsFile = path.join(directory, '.vars.json');

        return new Promise((resolve, reject) => {
            this._addJsonFile(this.watchedVarFiles, varsFile, 0, false, cb, resolve, reject);
        });
    }

    /**
     * Root directory changed
     * @param {string} eventType                        Either 'rename' or 'change'
     * @param {string|null} filename                    Name of the file
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
     * @param {string|null} filename                    Name of the file
     */
    onChangeUpdates(eventType, filename) {
        this._logger.debug('watcher', `Updates event: ${eventType}, ${filename}`);

        let files;
        try {
            files = fs.readdirSync(this._directory.updatesDir);
        } catch (error) {
            return;
        }

        for (let file of files) {
            let filename = path.join(this._directory.updatesDir, file);
            if (this.watchedUpdates.has(filename))
                continue;

            this._addJsonFile(
                this.watchedUpdates,
                filename,
                0,
                true,
                null,
                json => {
                    for (let update of json.vars || []) {
                        let parts = update.path.split('/');
                        let name = parts.pop();
                        let directory = parts.join('/');
                        let varsFile = path.join(this._directory.dataDir, directory, '.vars.json');
                        let info = this.watchedVarFiles.get(varsFile);
                        if (info)
                            info.mtime = update.mtime;

                        ((update, name, directory, varsFile, info) => {
                            if (update.event === 'delete') {
                                this._logger.debug('watcher', `Variable deleted: ${update.path}`);
                                this._cacher.unset(update.path)
                                    .then(() => {
                                        this._directory.notify(update.path, null);
                                    })
                                    .catch(error => {
                                        this._logger.error(new WError(error, 'Watcher.onChangeUpdates(): delete'));
                                    });
                            } else if (update.event === 'update') {
                                this._logger.debug('watcher', `Variable updated: ${update.path}`);
                                if (!info) {
                                    this._addJsonFile(
                                        this.watchedVarFiles,
                                        varsFile,
                                        update.mtime,
                                        true,
                                        null,
                                        json => {
                                            for (let key of Object.keys(json)) {
                                                let varName = path.join(directory || '/', key);
                                                ((varName, value) => {
                                                    this._cacher.get(varName)
                                                        .then(result => {
                                                            if (typeof result === 'undefined' || result === value)
                                                                return;

                                                            return this._cacher.set(varName, value);
                                                        })
                                                        .then(() => {
                                                            this._directory.notify(varName, value);
                                                        })
                                                        .catch(error => {
                                                            this._logger.error(new WError(error, 'Watcher.onChangeUpdates(): update'));
                                                        });
                                                })(varName, json[key]);
                                            }
                                        },
                                        error => {
                                            this._logger.error(`Vars file ${varsFile} error: ${error.message}`);
                                        }
                                    );
                                } else if (eventType !== 'init') {
                                    this._processJsonFile(this.watchedVarFiles, varsFile);
                                }
                            }
                        })(update, name, directory, varsFile, info);
                    }
                },
                error => {
                    this._logger.error(`Update file ${filename} error: ${error.message}`);
                }
            );
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
    onWatchedTimer() {
        let expiration = Date.now() - this.constructor.watchedPeriod;
        for (let [ filename, info ] of this.watchedVarFiles) {
            if (info.timestamp < expiration) {
                this._logger.debug('watcher', `Watched file expired: ${filename}`);
                if (info.watch)
                    info.watch.close();
                this.watchedVarFiles.delete(filename);
            }
        }
        for (let [ filename, info ] of this.watchedUpdates) {
            if (info.timestamp < expiration) {
                this._logger.debug('watcher', `Watched file expired: ${filename}`);
                if (info.watch)
                    info.watch.close();
                try {
                    fs.unlinkSync(filename);
                } catch (error) {
                    // do nothing
                }
                this.watchedUpdates.delete(filename);
            }
        }
    }

    /**
     * Create and watch updates directory
     */
    _watchUpdates() {
        let updates;
        try {
            fs.accessSync(this._directory.updatesDir, fs.constants.F_OK);
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

            this._logger.debug('watcher', `Watching ${this._directory.updatesDir}`);
            this.updatesWatcher = fs.watch(this._directory.updatesDir, this.onChangeUpdates.bind(this));
            if (!this.updatesWatcher)
                throw new Error('Could not install updates watcher');

            this.updatesWatcher.on('error', this.onErrorUpdates.bind(this));
            this._logger.info('Watcher installed');
            this.onChangeUpdates('init', null);
        } catch (error) {
            this._logger.error(new WError(error, 'Watcher._watchUpdates'));
        }
    }

    /**
     * Start watching JSON file
     * @param {Map} map                             Watchers map
     * @param {string} filename                     Path to file
     * @param {number} mtime                        Expected modification time of the file
     * @param {boolean} permanent                   Callbacks are not removed when fired
     * @param {function|null} processCallback       Process callback (called with { filename, json })
     * @param {function|null} successCallback       Success callback (called with { filename, json })
     * @param {function|null} errorCallback         Error callback (called with error)
     */
    _addJsonFile(map, filename, mtime, permanent, processCallback, successCallback, errorCallback) {
        this._logger.debug('watcher', `Adding ${filename}`);

        let info = map.get(filename);
        if (!info) {
            info = {
                timestamp: Date.now(),
                mtime: 0,
                watch: null,
                nextProcess: new Set(),
                nextSuccess: new Set(),
                nextError: new Set(),
                permanentProcess: new Set(),
                permanentSuccess: new Set(),
                permanentError: new Set(),
            };

            map.set(filename, info);
        }

        if (mtime)
            info.mtime = mtime;

        if (processCallback) {
            if (permanent)
                info.permanentProcess.add(processCallback);
            else
                info.nextProcess.add(processCallback);
        }

        if (successCallback) {
            if (permanent)
                info.permanentSuccess.add(successCallback);
            else
                info.nextSuccess.add(successCallback);
        }

        if (errorCallback) {
            if (permanent)
                info.permanentError.add(errorCallback);
            else
                info.nextError.add(errorCallback);
        }

        if (!info.watch) {
            let exists;
            try {
                let stat = fs.statSync(filename);
                if (info.mtime && Math.floor(stat.mtime.getTime() / 1000) < info.mtime)
                    return;
                exists = true;
            } catch (error) {
                exists = false;
            }
            if (exists)
                this._watchJsonFile(map, filename);
        }

        this._processJsonFile(map, filename);
    }

    /**
     * Install watcher for JSON file
     * @param {Map} map                             Watchers map
     * @param {string} filename                     Path to file
     */
    _watchJsonFile(map, filename) {
        this._logger.debug('watcher', `Watching ${filename}`);

        let info = map.get(filename);
        if (!info || info.watch)
            return;

        info.watch = fs.watch(filename, (eventType, name) => {
            this._logger.debug('watcher', `JSON ${filename} event: ${eventType}, ${name}`);
            this._processJsonFile(map, filename);
        });
        if (!info.watch) {
            for (let cb of info.nextError)
                cb(new Error(`Could not install updates watcher for ${filename}`));
            for (let cb of info.permanentError)
                cb(new Error(`Could not install updates watcher for ${filename}`));
            map.delete(filename);
            return;
        }
        info.watch.on('error', error => {
            this._logger.error(`JSON ${filename} error: ${error.message}`);
        });
    }

    /**
     * Process watched JSON file
     * @param {Map} map                             Watchers map
     * @param {string} filename                     Path to file
     */
    _processJsonFile(map, filename) {
        this._logger.debug('watcher', `Processing ${filename}`);

        let info = map.get(filename);
        if (!info)
            return;

        info.timestamp = Date.now();

        let exists;
        try {
            let stat = fs.statSync(filename);
            if (info.mtime && Math.floor(stat.mtime.getTime() / 1000) < info.mtime)
                return;
            exists = true;
        } catch (error) {
            exists = false;
        }
        if (exists && !info.watch)
            this._watchJsonFile(map, filename);

        let complete = (json, error) => {
            if (json) {
                for (let cb of info.nextProcess)
                    json = cb(json);

                for (let cb of info.permanentProcess)
                    json = cb(json);

                for (let cb of info.nextSuccess)
                    cb(json);

                for (let cb of info.permanentSuccess)
                    cb(json);
            } else {
                for (let cb of info.nextError)
                    cb(error);

                for (let cb of info.permanentError)
                    cb(error);
            }

            info.nextProcess.clear();
            info.nextSuccess.clear();
            info.nextError.clear();

            return json;
        };

        if (!info.nextProcess.size && !info.permanentProcess.size) {
            if (!exists)
                return complete({}, null);

            return this._filer.lockRead(filename)
                .then(contents => {
                    let again = map.get(filename);
                    if (!again || again !== info)
                        return;
                    if (again.nextProcess.size || again.permanentProcess.size)
                        return this._processJsonFile(map, filename);

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
                    let again = map.get(filename);
                    if (!again || again !== info)
                        return;
                    if (again.nextProcess.size || again.permanentProcess.size)
                        return this._processJsonFile(map, filename);

                    complete(null, error);
                });
        }

        return this._filer.lockUpdate(
                filename,
                contents => {
                    let again = map.get(filename);
                    if (!again || again !== info)
                        return Promise.resolve(contents);

                    let json;
                    try {
                        json = JSON.parse(contents);
                    } catch (error) {
                        if (exists) {
                            this._logger.debug('watcher', `Premature read of ${filename}`);
                            return Promise.resolve(contents);
                        } else {
                            json = {};
                        }
                    }

                    json = complete(json, null);
                    return Promise.resolve(JSON.stringify(json, undefined, 4) + '\n');
                },
                { mode: this._directory.fileMode, uid: this._directory.user, gid: this._directory.group }
            )
            .catch(error => {
                let again = map.get(filename);
                if (!again || again !== info)
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
