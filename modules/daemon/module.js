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

        let ls = this._app.get('modules.daemon.events.ls');
        server.on('ls', ls.handle.bind(ls));

        let set = this._app.get('modules.daemon.events.set');
        server.on('set', set.handle.bind(set));

        let get = this._app.get('modules.daemon.events.get');
        server.on('get', get.handle.bind(get));

        let del = this._app.get('modules.daemon.events.del');
        server.on('del', del.handle.bind(del));

        let rm = this._app.get('modules.daemon.events.rm');
        server.on('rm', rm.handle.bind(rm));

        let wait = this._app.get('modules.daemon.events.wait');
        server.on('wait', wait.handle.bind(wait));

        let touch = this._app.get('modules.daemon.events.touch');
        server.on('touch', touch.handle.bind(touch));

        let setAttr = this._app.get('modules.daemon.events.setAttr');
        server.on('set_attr', setAttr.handle.bind(setAttr));

        let getAttr = this._app.get('modules.daemon.events.getAttr');
        server.on('get_attr', getAttr.handle.bind(getAttr));

        let delAttr = this._app.get('modules.daemon.events.delAttr');
        server.on('del_attr', delAttr.handle.bind(delAttr));

        let upload = this._app.get('modules.daemon.events.upload');
        server.on('upload', upload.handle.bind(upload));

        let download = this._app.get('modules.daemon.events.download');
        server.on('download', download.handle.bind(download));

        let clearCache = this._app.get('modules.daemon.events.clearCache');
        server.on('clear_cache', clearCache.handle.bind(clearCache));

        return Promise.resolve();
    }
}

module.exports = Daemon;
