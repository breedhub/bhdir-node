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

        let createFolder = this._app.get('modules.daemon.events.createFolder');
        server.on('create_folder', createFolder.handle.bind(createFolder));

        let addFolder = this._app.get('modules.daemon.events.addFolder');
        server.on('add_folder', addFolder.handle.bind(addFolder));

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

        let exists = this._app.get('modules.daemon.events.exists');
        server.on('exists', exists.handle.bind(exists));

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

        let networkCreate = this._app.get('modules.daemon.events.networkCreate');
        server.on('network_create', networkCreate.handle.bind(networkCreate));

        let networkJoin = this._app.get('modules.daemon.events.networkJoin');
        server.on('network_join', networkJoin.handle.bind(networkJoin));

        let nodeCreate = this._app.get('modules.daemon.events.nodeCreate');
        server.on('node_create', nodeCreate.handle.bind(nodeCreate));

        let nodeRoles = this._app.get('modules.daemon.events.nodeRoles');
        server.on('node_roles', nodeRoles.handle.bind(nodeRoles));

        let index = this._app.get('modules.daemon.events.index');
        server.on('index', index.handle.bind(index));

        let vacuum = this._app.get('modules.daemon.events.vacuum');
        server.on('vacuum', vacuum.handle.bind(vacuum));

        let clearCache = this._app.get('modules.daemon.events.clearCache');
        server.on('clear_cache', clearCache.handle.bind(clearCache));

        return Promise.resolve();
    }
}

module.exports = Daemon;
