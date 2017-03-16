/**
 * Sync directory watcher
 * @module servers/watcher
 */
const debug = require('debug')('bhdir:watcher');
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
     * @param {Util} util                           Util service
     */
    constructor(app, config, logger, util) {
        super();

        this.updates = new Map();
        this.waiting = new Map();
        this.rootWatcher = null;
        this.updatesWatcher = null;

        this._name = null;
        this._app = app;
        this._config = config;
        this._logger = logger;
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
        return [ 'app', 'config', 'logger', 'util' ];
    }

    /**
     * Update entry lifetime
     */
    static get updatesLifetime() {
        return 30 * 60 * 1000; // ms
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
                if (!this._rootDir)
                    throw new Error('No root parameter in directory section of bhdir.conf');
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
                debug('Starting the server');
                this._sessionId = this._util.getRandomString(8, {lower: true, upper: true, digits: true, special: false});

                try {
                    fs.accessSync(this._rootDir, fs.constants.F_OK);
                } catch (error) {
                    throw new Error(`Directory ${this._rootDir} does not exist`);
                }

                debug(`Watching ${this._rootDir}`);
                this.rootWatcher = fs.watch(this._rootDir, this.onChangeRoot.bind(this));
                if (!this.rootWatcher)
                    throw new Error('Could not install root watcher');

                this.rootWatcher.on('error', this.onErrorRoot.bind(this));

                this._watchUpdates();

                let updatesPath = path.join(this._rootDir, 'updates');
                let files = fs.readdirSync(updatesPath);
                for (let file of files) {
                    let update = fs.readFileSync(path.join(updatesPath, file), 'utf8');
                    try {
                        let json = JSON.parse(update);
                        if (!json.path)
                            throw new Error('No path');

                        json.timestamp = Date.now();
                        this.updates.set(file, json);
                    } catch (error) {
                        fs.unlinkSync(path.join(updatesPath, file));
                    }
                }

                this._cleanUpdatesTimer = setInterval(this.onCleanUpdates.bind(this), this.constructor.cleanUpdatesInterval);
            });
    }

    /**
     * Wait for variable change
     * @param {string} filename                     Variable path
     * @param {number} timeout                      Timeout in ms, 0 for no timeout
     * @return {Promise}
     */
    wait(filename, timeout) {
        let info = this.waiting.get(filename);
        if (!info) {
            info = {
                handlers: new Set(),
            };
            this.waiting.set(filename, info);
        }

        return new Promise((resolve) => {
            let cb = result => {
                debug(`Wait on ${filename} timeout: ${result}`);
                resolve(result);
            };
            info.handlers.add(cb);
            if (timeout)
                setTimeout(() => { cb(true); }, timeout);
        });
    }

    /**
     * Wait for variable change
     * @param {string} filename                     Variable path
     * @return {Promise}
     */
    touch(filename) {
        this.notify(filename);
        return new Promise((resolve, reject) => {
            try {
                let json = {
                    path: filename,
                };
                let update = path.join(
                    this._rootDir,
                    'updates',
                    Date.now() + '.' + this._sessionId + '.json'
                );
                fs.writeFileSync(update, JSON.stringify(json) + '\n');
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Notify about variable change
     * @param {string} filename                     Variable path
     */
    notify(filename) {
        let waiting = this.waiting.get(filename);
        if (!waiting)
            return;

        for (let cb of waiting.handlers)
            cb(false);
        this.waiting.delete(filename);
    }

    /**
     * Root directory changed
     * @param {string} eventType                        Either 'rename' or 'change'
     * @param {string} [filename]                       Name of the file
     */
    onChangeRoot(eventType, filename) {
        debug(`Root event: ${eventType}, ${filename}`);
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
        debug(`Updates event: ${eventType}, ${filename}`);
        let updatesPath = path.join(this._rootDir, 'updates');
        try {
            let updates = [];
            let files = fs.readdirSync(updatesPath);
            for (let file of files) {
                if (this.updates.has(file))
                    continue;

                let update = fs.readFileSync(path.join(updatesPath, file), 'utf8');
                try {
                    let json = JSON.parse(update);
                    if (!json.path)
                        throw new Error('No path');

                    json.timestamp = Date.now();
                    this.updates.set(file, json);

                    let parts = file.split('.');
                    if (parts.length >= 3 && parts[1] != this._sessionId)
                       updates.push(json);
                } catch (error) {
                    fs.unlinkSync(path.join(updatesPath, file));
                }
            }

            for (let update of updates) {
                debug(`Path updated: ${update.path}`);
                this.notify(update.path);
            }
        } catch (error) {
            this._logger.error(new WError(error, 'Watcher._watchUpdates'));
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
                debug(`Update expired: ${name}`);
                fs.unlinkSync(path.join(updatesPath, name));
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
            } else {
                return;
            }
        }

        try {
            if (!updates)
                fs.mkdirSync(updatesPath, 0o755);

            debug(`Watching ${updatesPath}`);
            this.updatesWatcher = fs.watch(updatesPath, this.onChangeUpdates.bind(this));
            if (!this.updatesWatcher)
                throw new Error('Could not install updates watcher');

            this.updatesWatcher.on('error', this.onErrorUpdates.bind(this));
            this._logger.info('Watcher installed');
        } catch (error) {
            this._logger.error(new WError(error, 'Watcher._watchUpdates'));
        }
    }
}

module.exports = Watcher;
