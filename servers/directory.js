/**
 * Directory data server
 * @module servers/directory
 */
const debug = require('debug')('bhdir:directory');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ini = require('ini');
const EventEmitter = require('events');
const WError = require('verror').WError;

/**
 * Server class
 */
class Directory extends EventEmitter {
    /**
     * Create the service
     * @param {App} app                             Application
     * @param {object} config                       Configuration
     * @param {Logger} logger                       Logger service
     * @param {Filer} filer                         Filer service
     */
    constructor(app, config, logger, filer) {
        super();

        this._name = null;
        this._app = app;
        this._config = config;
        this._logger = logger;
        this._filer = filer;
    }

    /**
     * Service name is 'servers.directory'
     * @type {string}
     */
    static get provides() {
        return 'servers.directory';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'logger', 'filer' ];
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
                let _rootDir = bhdirConfig.directory && bhdirConfig.directory.root;
                if (!_rootDir)
                    throw new Error('No root parameter in directory section of bhdir.conf');

                this._dataDir = path.join(_rootDir, 'data');
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
            });
    }

    /**
     * Get variable
     */
    get(filename) {
        let parts = filename.split('/');
        let name = parts.pop();
        let directory = path.join(this._dataDir, parts.join('/'));

        return this._filer.lockRead(path.join(directory, 'vars.json'))
            .then(content => {
                if (content)
                    content = content.trim();
                if (!content)
                    return null;

                let json = JSON.parse(content);
                return json[name] || null;
            })
            .catch(error => {
                if (error.code == 'ENOENT')
                    return null;

                throw error;
            });
    }
}

module.exports = Directory;
