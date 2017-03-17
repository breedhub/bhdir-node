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
     * Clean updates directory interval
     */
    static get retryUpdateInterval() {
        return 1000; // ms
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
                let configPath = (os.platform() == 'freebsd' ? '/usr/local/etc/bhdir' : '/etc/bhdir');
                try {
                    fs.accessSync(path.join(configPath, 'bhdir.conf'), fs.constants.F_OK);
                } catch (error) {
                    throw new Error('Could not read bhdir.conf');
                }

                let bhdirConfig = ini.parse(fs.readFileSync(path.join(configPath, 'bhdir.conf'), 'utf8'));
                this._rootDir = bhdirConfig.directory && bhdirConfig.directory.root;
                if (!this._rootDir) {
                    this._logger.error('No root parameter in directory section of bhdir.conf');
                    process.exit(1);
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

                this._logger.debug('watcher', `Watching ${this._rootDir}`);
                this.rootWatcher = fs.watch(this._rootDir, this.onChangeRoot.bind(this));
                if (!this.rootWatcher)
                    throw new Error('Could not install root watcher');

                this.rootWatcher.on('error', this.onErrorRoot.bind(this));

                this._watchUpdates();

                let files, updatesPath = path.join(this._rootDir, 'updates');
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

        let files, updatesPath = path.join(this._rootDir, 'updates');
        try {
            files = fs.readdirSync(updatesPath);
        } catch (error) {
            return;
        }

        for (let file of files) {
            if (this.updates.has(file))
                continue;

            this._readUpdate(path.join(updatesPath, file))
                .then(json => {
                    if (!json)
                        return;

                    let parts = file.split('.');
                    if (parts.length >= 3 && parts[1] != this.sessionId) {
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
        let updatesPath = path.join(this._rootDir, 'updates');
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
        let updates, updatesPath = path.join(this._rootDir, 'updates');
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

    /**
     * Read update file until it parses
     * @param {string} filename                 Filename
     * @return {Promise}
     */
    _readUpdate(filename) {
        return new Promise((resolve, reject) => {
            if (this.updates.has(path.basename(filename)))
                return resolve(null);

            let init = { timestamp: Date.now() };
            this.updates.set(path.basename(filename), init);

            let read = () => {
                if (!this.updates.has(path.basename(filename)))
                    return resolve(null);

                this._filer.lockRead(filename)
                    .then(update => {
                        if (!this.updates.has(path.basename(filename)))
                            return resolve(null);

                        let json;
                        try {
                            json = JSON.parse(update);
                        } catch (error) {
                            return setTimeout(() => { read(); }, this.constructor.retryUpdateInterval);
                        }

                        if (!json.paths) {
                            this._logger.error(`Update parse error: no paths`);
                            try {
                                fs.unlinkSync(filename);
                            } catch (error) {
                                // do nothing
                            }
                            return resolve(null);
                        }

                        json.timestamp = init.timestamp;
                        this.updates.set(path.basename(filename), json);
                        resolve(json);
                    })
                    .catch(error => {
                        if (error.code == 'ENOENT')
                            return resolve(null);

                        reject(new WError(error, 'Watcher._readUpdate()'));
                    });
            };
            read();
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
