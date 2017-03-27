/**
 * Daemon state
 * @module servers/state
 */
const path = require('path');
const fs = require('fs');
const uuid = require('uuid');
const EventEmitter = require('events');
const WError = require('verror').WError;

/**
 * Server class
 */
class State extends EventEmitter {
    /**
     * Create the service
     * @param {App} app                             Application
     * @param {object} config                       Configuration
     * @param {Logger} logger                       Logger service
     * @param {Filer} filer                         Filer service
     */
    constructor(app, config, logger, filer) {
        super();

        this.sessionId = uuid.v4();
        this.started = Math.round(Date.now() / 1000);
        this.dirWatcher = null;
        this.files = new Map();

        this._name = null;
        this._app = app;
        this._config = config;
        this._logger = logger;
        this._filer = filer;
    }

    /**
     * Service name is 'servers.state'
     * @type {string}
     */
    static get provides() {
        return 'servers.state';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'logger', 'filer', 'cacher' ];
    }

    /**
     * Update state file interval
     * @type {number}
     */
    static get updateInterval() {
        return 60 * 1000;
    }

    /**
     * Expire state file timeout
     * @type {number}
     */
    static get expirationTimeout() {
        return 5 * 60 * 1000;
    }

    /**
     * Clean expired state files interval
     * @type {number}
     */
    static get cleanInterval() {
        return 10 * 1000;
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
                this._logger.debug('state', 'Starting the server');

                this._logger.debug('state', `Watching ${this._directory.stateDir}`);
                this.dirWatcher = fs.watch(this._directory.stateDir, this.onChangeDir.bind(this));
                if (!this.dirWatcher) {
                    this._logger.error(`Could not install watcher for ${this._directory.stateDir}`);
                    return;
                }

                this.dirWatcher.on('error', this.onErrorDir.bind(this));

                this._updateTimer = setInterval(this.onUpdateTimer.bind(this), this.constructor.updateInterval);
                this._cleanTimer = setInterval(this.onCleanTimer.bind(this), this.constructor.cleanInterval);

                this.onUpdateTimer();
                this.onChangeDir('init', null);
            });
    }

    /**
     * State directory changed
     * @param {string} eventType                        'rename', 'change' or 'init'
     * @param {string|null} filename                    Name of the file
     */
    onChangeDir(eventType, filename) {
        this._logger.debug('state', `State directory event: ${eventType}, ${filename}`);

        let files = fs.readdirSync(this._directory.stateDir);
        for (let file of files) {
            let stats;
            try {
                stats = fs.statSync(path.join(this._directory.stateDir, file));
            } catch (error) {
                continue;
            }
            this.files.set(file, stats.mtime);
        }
    }

    /**
     * State directory error
     * @param {Error} error                             Error object
     */
    onErrorDir(error) {
        this._logger.error(`State directory error: ${error.message}`);
    }

    /**
     * Update state file
     */
    onUpdateTimer() {
        let json = {
            id: this.sessionId,
            started: this.started,
            updated: Math.round(Date.now() / 1000),
        };

        try {
            fs.writeFileSync(
                path.join(this._directory.stateDir, this.sessionId + '.json'),
                JSON.stringify(json, undefined, 4) + '\n'
            );
        } catch (error) {
            // do nothing
        }
    }

    /**
     * Clean old files
     */
    onCleanTimer() {
        let expired = Date.now() - this.constructor.expirationTimeout;
        for (let [ file, mtime ] of this.files) {
            if (mtime < expired) {
                this.files.delete(file);
                try {
                    fs.unlinkSync(path.join(this._directory.stateDir, file));
                } catch (error) {
                    // do nothing
                }
            }
        }
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

module.exports = State;
