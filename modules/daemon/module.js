/**
 * Daemon module
 * @module daemon/module
 */
const path = require('path');

/**
 * Module main class
 */
class Daemon {
    /**
     * Create the module
     * @param {App} app             The application
     * @param {object} config       Configuration
     * @param {Logger} logger       Logger service
     */
    constructor(app, config, logger) {
        this._app = app;
        this._config = config;
        this._logger = logger;
    }

    /**
     * Service name is 'modules.daemon'
     * @type {string}
     */
    static get provides() {
        return 'modules.daemon';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'logger' ];
    }

    /**
     * Bootstrap the module
     * @return {Promise}
     */
    bootstrap() {
        return Promise.resolve();
    }

    /**
     * Register with the server
     * @param {string} name                     Server name as in config
     * @return {Promise}
     */
    register(name) {
        if (this._config.get(`servers.${name}.class`) !== 'servers.daemon')
            return Promise.resolve();

        let server = this._app.get('servers').get('daemon');

        let set = this._app.get('modules.daemon.events.set');
        server.on('set', set.handle.bind(set));

        let get = this._app.get('modules.daemon.events.get');
        server.on('get', get.handle.bind(get));

        let del = this._app.get('modules.daemon.events.del');
        server.on('del', del.handle.bind(del));

        let wait = this._app.get('modules.daemon.events.wait');
        server.on('wait', wait.handle.bind(wait));

        let touch = this._app.get('modules.daemon.events.touch');
        server.on('touch', touch.handle.bind(touch));

        let clearCache = this._app.get('modules.daemon.events.clearCache');
        server.on('clear_cache', clearCache.handle.bind(clearCache));

        return Promise.resolve();
    }
}

module.exports = Daemon;
