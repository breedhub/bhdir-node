/**
 * Resilio log resilio
 * @module servers/resilio
 */
const path = require('path');
const fs = require('fs');
const uuid = require('uuid');
const EventEmitter = require('events');
const WError = require('verror').WError;

/**
 * Server class
 */
class Resilio extends EventEmitter {
    /**
     * Create the service
     * @param {App} app                             Application
     * @param {object} config                       Configuration
     * @param {Logger} logger                       Logger service
     * @param {Filer} filer                         Filer service
     * @param {Cacher} cacher                       Cacher service
     */
    constructor(app, config, logger, filer, cacher) {
        super();

        this.sessionId = uuid.v1();
        this.dirWatcher = null;
        this.logWatcher = null;
        this.logInode = null;
        this.logStart = 0;
        this.logEnd = 0;
        this.log = new Buffer(0);

        this._name = null;
        this._app = app;
        this._config = config;
        this._logger = logger;
        this._filer = filer;
        this._cacher = cacher;
    }

    /**
     * Service name is 'servers.resilio'
     * @type {string}
     */
    static get provides() {
        return 'servers.resilio';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'logger', 'filer', 'cacher' ];
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
                this._logger.debug('resilio', 'Starting the server');

                let dir = path.dirname(this._directory.syncLog);
                this._logger.debug('resilio', `Watching ${dir}`);
                this.dirWatcher = fs.watch(dir, this.onChangeDir.bind(this));
                if (!this.dirWatcher) {
                    this._logger.error(`Could not install watcher for ${dir}`);
                    return;
                }

                this.dirWatcher.on('error', this.onErrorDir.bind(this));

                try {
                    let stats = fs.statSync(this._directory.syncLog);
                    this.logStart = this.logEnd = stats.size;
                } catch (error) {
                    // no nothing
                }

                this.onChangeDir('init', null);
            });
    }

    /**
     * Resilio directory changed
     * @param {string} eventType                        'rename', 'change' or 'init'
     * @param {string|null} filename                    Name of the file
     */
    onChangeDir(eventType, filename) {
        if (eventType === 'change')
            return;

        this._logger.debug('resilio', `Resilio directory event: ${eventType}, ${filename}`);

        let stats;
        try {
            stats = fs.statSync(this._directory.syncLog);
        } catch (error) {
            stats = null;
        }

        if (!stats || (this.logInode && stats.ino !== this.logInode)) {
            if (this.logWatcher) {
                this.logWatcher.close();
                this.logWatcher = null;
            }
        }

        if (stats && !this.logWatcher) {
            if (this.logInode)
                this.logStart = this.logEnd = 0;
            this.logInode = stats.ino;

            this._logger.debug('resilio', `Watching ${this._directory.syncLog}`);
            this.logWatcher = fs.watch(this._directory.syncLog, this.onChangeLog.bind(this));
            if (!this.logWatcher) {
                this._logger.error(`Could not install watcher for ${this._directory.syncLog}`);
            } else {
                this.logWatcher.on('error', this.onErrorLog.bind(this));
                this.onChangeLog('init', null);
                this._directory.clearCache()
                    .catch(error => {
                        this._logger.error(`Clear cacher error: ${error.message}`);
                    });
            }
        }
    }

    /**
     * Resilio directory error
     * @param {Error} error                             Error object
     */
    onErrorDir(error) {
        this._logger.error(`Resilio directory error: ${error.message}`);
    }

    /**
     * Resilio sync log changed
     * @param {string} eventType                        'rename', 'change' or 'init'
     * @param {string|null} filename                    Name of the file
     */
    onChangeLog(eventType, filename) {
//        this._logger.debug('resilio', `Resilio sync log event: ${eventType}, ${filename}`);
        this.loadLog();
    }

    /**
     * Resilio sync log error
     * @param {Error} error                             Error object
     */
    onErrorLog(error) {
        this._logger.error(`Resilio sync log error: ${error.message}`);
    }

    /**
     * Load sync log
     */
    loadLog() {
        if (this._loadingLog) {
            this._reloadLog = true;
            return;
        }

        this._loadingLog = true;
        this._reloadLog = false;

        let stats;
        try {
            stats = fs.statSync(this._directory.syncLog);
        } catch (error) {
            this._logger.debug('resilio', `Sync log disappeared`);
            this._loadingLog = false;
            return;
        }

        if (stats.size < this.logEnd) {
//            this._logger.debug('resilio', `Sync log truncated to ${stats.size}`);
            this.logStart = 0;
            this.logEnd = stats.size;
        } else if (stats.size > this.logEnd) {
//            this._logger.debug('resilio', `Sync log expanded by ${stats.size - this.logEnd}`);
            this.logStart = this.logEnd;
            this.logEnd = stats.size;
        } else {
            this._loadingLog = false;
            return;
        }

        let exit = error => {
            if (error)
                this._logger.error(`Sync log load error: ${error.message}`);

            this.parseLog();

            this._loadingLog = false;
            if (this._reloadLog) {
                this._reloadLog = false;
                this.loadLog();
            }
        };

        let fd;
        try {
            fd = fs.openSync(this._directory.syncLog, 'r');
        } catch (error) {
            return exit(error);
        }

        let buffer = Buffer.allocUnsafe(this.logEnd - this.logStart);
        fs.read(
            fd,
            buffer,
            0,
            buffer.length,
            this.logStart,
            (error, bytesRead, buffer) => {
                try {
                    fs.closeSync(fd);
                } catch (error) {
                    // do nothing
                }

                if (error)
                    return exit(error);
                if (bytesRead !== buffer.length) {
                    this.logEnd = this.logStart + bytesRead;
                    this._logger.error(`Only ${bytesRead} out of ${buffer.length} has been read from sync log`);
                }

                this.log = Buffer.concat([ this.log, buffer.slice(0, bytesRead) ]);

                exit();
            }
        );
    }

    /**
     * Parse sync log
     */
    parseLog() {
        if (this._checkingLog) {
            this._recheckLog = true;
            return;
        }

        this._checkingLog = true;
        this._recheckLog = false;

        let exit = error => {
            if (error)
                this._logger.error(`Sync log parse error: ${error.message}`);

            this._checkingLog = false;
            if (this._recheckLog) {
                this._recheckLog = false;
                this.parseLog();
            }
        };

        if (!this.log.length)
            return exit();

        let str = this.log.toString('utf8');
        this.log = new Buffer(0);

        let files = [];
        let re = /^\[.+?\] Finished downloading file "(.+)"$/;
        for (let line of str.trim().split('\n')) {
            line = line.trim();
            if (!line.length)
                continue;
            let result = re.exec(line);
            if (!result)
                continue;

            let file;
            if (result[1].indexOf('/.files/') !== -1)
                continue;
            if (result[1].startsWith(this._directory.dataDir) && result[1].endsWith('/.vars.json'))
                file = path.dirname(result[1]);

            if (file && files.indexOf(file) === -1) {
                this._logger.info(`Path updated: ${file}`);
                files.push(file);
            }
        }

        let promises = [];
        for (let file of files)
            promises.push(this._filer.lockRead(path.join(file, '.vars.json')));

        if (!promises.length)
            return exit();

        Promise.all(promises)
            .then(results => {
                promises = [];
                for (let i = 0; i < files.length; i++) {
                    let json;
                    try {
                        json = JSON.parse(results[i]);
                    } catch (error) {
                        continue;
                    }

                    for (let key of Object.keys(json)) {
                        ((file, key, json) => {
                            let directory = file.substring(this._directory.dataDir.length);
                            let varName = path.join(directory, key);
                            promises.push(
                                this._cacher.get(varName)
                                    .then(result => {
                                        if (!result)
                                            return;

                                        this._cacher.set(varName, json[key]);
                                    })
                                    .then(() => {
                                        this._directory.notify(varName, json[key]);
                                    })
                            );
                        })(files[i], key, json);
                    }
                }

                if (promises.length)
                    return Promise.all(promises);
            })
            .then(
                () => {
                    exit();
                },
                error => {
                    exit(error);
                }
            );
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

module.exports = Resilio;
