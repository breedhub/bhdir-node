/**
 * Role Remove event
 * @module daemon/events/role-remove
 */
const uuid = require('uuid');
const WError = require('verror').WError;

/**
 * Role Remove event class
 */
class RoleRemove {
    /**
     * Create service
     * @param {App} app                             The application
     * @param {object} config                       Configuration
     * @param {Logger} logger                       Logger service
     */
    constructor(app, config, logger) {
        this._app = app;
        this._config = config;
        this._logger = logger;
    }

    /**
     * Service name is 'modules.daemon.events.roleRemove'
     * @type {string}
     */
    static get provides() {
        return 'modules.daemon.events.roleRemove';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'logger' ];
    }

    /**
     * Event handler
     * @param {string} id           ID of the client
     * @param {object} message      The message
     */
    handle(id, message) {
        let client = this.daemon.clients.get(id);
        if (!client)
            return;

        this._logger.debug('role-remove', `Got ROLE REMOVE command`);
        let reply = (success, value) => {
            let reply = {
                id: message.id,
                success: success,
            };
            if (!success)
                reply.message = value;
            let data = Buffer.from(JSON.stringify(reply), 'utf8');
            this._logger.debug('role-remove', `Sending ROLE REMOVE response`);
            this.daemon.send(id, data);
        };

        if (message.args.length !== 2)
            return reply(false, 'Invalid arguments list');

        let name = message.args[0];
        let roles = new Set(message.args[1]);
        for (let role of roles) {
            if (this.syncthing.constructor.roles.indexOf(role) === -1)
                return reply(false, 'Invalid role');
        }

        Array.from(roles).reduce(
                (prev, cur) => {
                    return prev.then(() => {
                        return this.syncthing.removeRole(name, cur);
                    });
                },
                Promise.resolve()
            )
            .then(() => {
                reply(true);
            })
            .catch(error => {
                reply(false, error.message);
                this._logger.error(new WError(error, 'RoleRemove.handle()'));
            });
    }

    /**
     * Retrieve daemon server
     * @return {Daemon}
     */
    get daemon() {
        if (this._daemon)
            return this._daemon;
        this._daemon = this._app.get('servers').get('daemon');
        return this._daemon;
    }

    /**
     * Retrieve directory server
     * @return {Directory}
     */
    get directory() {
        if (this._directory)
            return this._directory;
        this._directory = this._app.get('servers').get('directory');
        return this._directory;
    }

    /**
     * Retrieve syncthing server
     * @return {Syncthing}
     */
    get syncthing() {
        if (this._syncthing)
            return this._syncthing;
        this._syncthing = this._app.get('servers').get('syncthing');
        return this._syncthing;
    }
}

module.exports = RoleRemove;