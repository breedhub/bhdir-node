/**
 * Syncthing server
 * @module servers/syncthing
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const EventEmitter = require('events');
const WError = require('verror').WError;

/**
 * Server class
 */
class Syncthing extends EventEmitter {
    /**
     * Create the service
     * @param {App} app                             Application
     * @param {object} config                       Configuration
     * @param {Logger} logger                       Logger service
     * @param {Runner} runner                       Runner service
     * @param {Filer} filer                         Filer service
     * @param {Cacher} cacher                       Cacher service
     */
    constructor(app, config, logger, runner, filer, cacher) {
        super();

        this.syncthing = null;

        this._name = null;
        this._app = app;
        this._config = config;
        this._logger = logger;
        this._runner = runner;
        this._filer = filer;
        this._cacher = cacher;
    }

    /**
     * Service name is 'servers.syncthing'
     * @type {string}
     */
    static get provides() {
        return 'servers.syncthing';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'logger', 'runner', 'filer', 'cacher' ];
    }

    /**
     * Syncthing version
     * @type {string}
     */
    static get version() {
        return '0.14.26';
    }

    /**
     * Get main bin path
     * @return {Promise}
     */
    static getMainBinary() {
        return Promise.resolve(path.join(__dirname, '..', 'dist', `syncthing-${this.version}`))
            .then(bin => {
                let ver;
                if (os.platform() === 'freebsd') {
                    ver = os.release().replace(/^([0-9]+).*$/, '$1');
                } else {
                    try {
                        let release = fs.readFileSync('/etc/debian_version', 'utf8');
                        ver = release.replace(/^([0-9]+).*$/, '$1');
                    } catch (error) {
                        return null;
                    }
                }
                return path.join(bin, os.platform() + '-' + ver + '-' + os.arch());
            })
            .then(bin => {
                if (!bin)
                    return null;

                try {
                    fs.accessSync(path.join(bin, 'syncthing'), fs.constants.X_OK);
                } catch (error) {
                    return null;
                }

                return path.join(bin, 'syncthing');
            });
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
                this._logger.debug('syncthing', 'Starting the server');
                return this.startMainBinary();
            });
    }

    /**
     * Start main binary
     */
    startMainBinary() {
        if (this.syncthing)
            return Promise.resolve();

        return this.constructor.getMainBinary()
            .then(syncthing => {
                if (!syncthing)
                    throw new Error('No syncthing found');

                return this._runner.spawn(
                    syncthing,
                    [
                        '-home=/var/lib/bhdir/.syncthing',
                        '-no-restart',
                        '-paused',
                    ],
                    {
                        env: {
                            "LANGUAGE": "C.UTF-8",
                            "LANG": "C.UTF-8",
                            "LC_ALL": "C.UTF-8",
                            "PATH": "/bin:/sbin:/usr/bin:/usr/sbin:/usr/local/bin:/usr/local/sbin",
                            "STNODEFAULTFOLDER": "1",
                            "STNOUPGRADE": "1",
                            "HOME": '/var/lib/bhdir/.syncthing',
                        }
                    }
                );
            })
            .then(sub => {
                this._logger.info('Syncthing main binary started');
                this.syncthing = sub;

                let logger = this._app.get('logger');
                logger.setLogStream('syncthing');

                sub.cmd.on('data', data => { logger.dump(data.toString().trim()); });
                sub.promise
                    .then(
                        result => {
                            this.syncthing = null;
                            this._logger.info(`Syncthing main binary terminated: ${result.code}`);
                        },
                        error => {
                            this.syncthing = null;
                            this._logger.error(`Syncthing main binary error: ${error.message}`);
                        }
                    );
            });
    }
}

module.exports = Syncthing;
