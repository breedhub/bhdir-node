/**
 * Coordinator module
 * @module coordinator/module
 */
const path = require('path');

/**
 * Module main class
 */
class Coordinator {
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
     * Service name is 'modules.coordinator'
     * @type {string}
     */
    static get provides() {
        return 'modules.coordinator';
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
        if (this._config.get(`servers.${name}.class`) !== 'servers.coordinator')
            return Promise.resolve();

        let server = this._app.get('servers').get('coordinator');

        let joinNetworkRequest = this._app.get('modules.coordinator.events.joinNetworkRequest');
        server.on('join_network_request', joinNetworkRequest.handle.bind(joinNetworkRequest));

        return Promise.resolve();
    }
}

module.exports = Coordinator;
