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
     */
    constructor(app, config, logger) {
        super();

        this.rootWatcher = null;
        this.updatesWatcher = null;

        this._name = null;
        this._app = app;
        this._config = config;
        this._logger = logger;
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
        return [ 'app', 'config', 'logger' ];
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
                try {
                    fs.accessSync(this._rootDir, fs.constants.F_OK);
                } catch (error) {
                    throw new Error(`Directory ${this._rootDir} does not exist`);
                }

                debug(`Watching ${this._rootDir}`);
                this.rootWatcher = fs.watch(this._rootDir, this.onChangeRoot.bind(this));
                this.rootWatcher.on('error', this.onErrorRoot.bind(this));

                let updates, updatesPath = path.join(this._rootDir, 'updates');
                try {
                    fs.accessSync(updatesPath, fs.constants.F_OK);
                    updates = true;
                } catch (error) {
                    updates = false;
                }
                if (updates) {
                    debug(`Watching ${updatesPath}`);
                    this.updatesWatcher = fs.watch(updatesPath, this.onChangeUpdates.bind(this));
                    this.updatesWatcher.on('error', this.onErrorUpdates.bind(this));
                }
            });
    }

    /**
     * Root directory changed
     * @param {string} eventType                        Either 'rename' or 'change'
     * @param {string} [filename]                       Name of the file
     */
    onChangeRoot(eventType, filename) {
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
    }

    /**
     * Updates directory watcher error
     * @param {Error} error                             Error object
     */
    onErrorUpdates(error) {
        this._logger.error(`Updates directory error: ${error.message}`);
    }
}

module.exports = Watcher;
