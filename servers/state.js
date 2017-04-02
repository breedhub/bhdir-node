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
        this.states = new Map();

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
        return [ 'app', 'config', 'logger', 'filer' ];
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

        return Promise.resolve()
            .then(() => {
                for (let [ directory, info ] of this._directory.directories) {
                    let state = {
                        stateDir: info.stateDir,
                        dirMode: info.dirMode,
                        fileMode: info.fileMode,
                        uid: info.uid,
                        gid: info.gid,
                        dirWatcher: null,
                        files: new Map(),
                    };

                    this.states.set(directory, state);
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
                this._logger.debug('state', 'Starting the server');

                for (let [ directory, info ] of this.states) {
                    this._logger.debug('state', `Watching ${info.stateDir}`);
                    info.dirWatcher = fs.watch(info.stateDir, (eventType, filename) => { this.onChangeDir(directory, eventType, filename); });
                    if (!info.dirWatcher) {
                        this._logger.error(`Could not install watcher for ${info.stateDir}`);
                        continue;
                    }

                    info.dirWatcher.on('error', error => { this.onErrorDir(directory, error); });
                    this.onChangeDir(directory, 'init', null);
                }

                this._updateTimer = setInterval(this.onUpdateTimer.bind(this), this.constructor.updateInterval);
                this._cleanTimer = setInterval(this.onCleanTimer.bind(this), this.constructor.cleanInterval);

                this.onUpdateTimer();
            });
    }

    /**
     * State directory changed
     * @param {string} directory                        Directory name
     * @param {string} eventType                        'rename', 'change' or 'init'
     * @param {string|null} filename                    Name of the file
     */
    onChangeDir(directory, eventType, filename) {
        this._logger.debug('state', `State directory event for ${directory}: ${eventType}, ${filename}`);
        let info = this.states.get(directory);

        let files = fs.readdirSync(info.stateDir);
        for (let file of files) {
            let stats;
            try {
                stats = fs.statSync(path.join(info.stateDir, file));
            } catch (error) {
                continue;
            }
            info.files.set(file, stats.mtime);
        }
    }

    /**
     * State directory error
     * @param {string} directory                        Directory name
     * @param {Error} error                             Error object
     */
    onErrorDir(directory, error) {
        this._logger.error(`State directory error for ${directory}: ${error.message}`);
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

        for (let [ directory, info ] of this.states) {
            this._filer.lockWrite(
                    path.join(info.stateDir, this.sessionId + '.json'),
                    JSON.stringify(json, undefined, 4) + '\n',
                    { mode: info.fileMode, uid: info.uid, gid: info.gid }
                )
                .catch(() => {
                    // do nothing
                });
        }
    }

    /**
     * Clean old files
     */
    onCleanTimer() {
        let expired = Date.now() - this.constructor.expirationTimeout;
        for (let [ directory, info ] of this.states) {
            for (let [ file, mtime ] of info.files) {
                if (mtime < expired) {
                    info.files.delete(file);
                    try {
                        fs.unlinkSync(path.join(info.stateDir, file));
                    } catch (error) {
                        // do nothing
                    }
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
