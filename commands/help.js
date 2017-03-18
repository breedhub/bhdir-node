/**
 * Help command
 * @module commands/help
 */

/**
 * Command class
 */
class Help {
    /**
     * Create the service
     * @param {App} app                 The application
     * @param {object} config           Configuration
     * @param {Util} util               Utility service
     */
    constructor(app, config, util) {
        this._app = app;
        this._config = config;
        this._util = util;
    }

    /**
     * Service name is 'commands.help'
     * @type {string}
     */
    static get provides() {
        return 'commands.help';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'util' ];
    }

    /**
     * Run the command
     * @param {object} argv             Minimist object
     * @return {Promise}
     */
    run(argv) {
        if (argv['_'].length < 2)
            return this.usage();

        let method = this[`help${this._util.dashedToCamel(argv['_'][1], true)}`];
        if (typeof method != 'function')
            return this.usage();

        return method.call(this, argv);
    }

    /**
     * General help
     * @return {Promise}
     */
    usage() {
        return this._app.info(
                'Usage:\tbhdirctl <command> [<parameters]\n\n' +
                'Commands:\n' +
                '\thelp\t\tPrint help about any other command\n' +
                '\tinstall\t\tRegister the program in the system\n' +
                '\tset\t\tSet variable value\n' +
                '\tget\t\tGet variable value\n' +
                '\tunset\t\tUnset variable\n' +
                '\twait\t\tWait for variable update\n' +
                '\ttouch\t\tTrigger variable update\n' +
                '\tstart\t\tStart the daemon\n' +
                '\tstop\t\tStop the daemon\n' +
                '\trestart\t\tRestart the daemon\n' +
                '\tstatus\t\tQuery running status of the daemon\n'
            )
            .then(() => {
                process.exit(0);
            });
    }

    /**
     * Help command
     * @param {object} argv             Minimist object
     * @return {Promise}
     */
    helpHelp(argv) {
        return this._app.info(
                'Usage:\tbhdirctl help <command>\n\n' +
                '\tPrint help for the given command\n'
            )
            .then(() => {
                process.exit(0);
            });
    }

    /**
     * Install command
     * @param {object} argv             Minimist object
     * @return {Promise}
     */
    helpInstall(argv) {
        return this._app.info(
                'Usage:\tbhdirctl install\n\n' +
                '\tThis command will register the program in the system\n' +
                '\tand will create configuration in /etc/bhid by default\n'
            )
            .then(() => {
                process.exit(0);
            });
    }

    /**
     * Set command
     * @param {object} argv             Minimist object
     * @return {Promise}
     */
    helpSet(argv) {
        return this._app.info(
                'Usage:\tbhdirctl set <path> <value> [-t <type>] [-z <socket>]\n\n' +
                '\tSet variable to a value. <type> could be one of: string (default), number, boolean and json.\n'
            )
            .then(() => {
                process.exit(0);
            });
    }

    /**
     * Get command
     * @param {object} argv             Minimist object
     * @return {Promise}
     */
    helpGet(argv) {
        return this._app.info(
                'Usage:\tbhdirctl get <path>\n\n' +
                '\tGet variable value\n'
            )
            .then(() => {
                process.exit(0);
            });
    }

    /**
     * Unset command
     * @param {object} argv             Minimist object
     * @return {Promise}
     */
    helpUnset(argv) {
        return this._app.info(
                'Usage:\tbhdirctl unset <path> [-z <socket>]\n\n' +
                '\tDelete a variable.\n'
            )
            .then(() => {
                process.exit(0);
            });
    }

    /**
     * Wait command
     * @param {object} argv             Minimist object
     * @return {Promise}
     */
    helpWait(argv) {
        return this._app.info(
                'Usage:\tbhdirctl wait <path>\n\n' +
                '\tWait for variable update event and return new value.\n'
            )
            .then(() => {
                process.exit(0);
            });
    }


    /**
     * Touch command
     * @param {object} argv             Minimist object
     * @return {Promise}
     */
    helpTouch(argv) {
        return this._app.info(
                'Usage:\tbhdirctl touch <path>\n\n' +
                '\tTrigger variable update event.\n'
            )
            .then(() => {
                process.exit(0);
            });
    }

    /**
     * Start command
     * @param {object} argv             Minimist object
     * @return {Promise}
     */
    helpStart(argv) {
        return this._app.info(
                'Usage:\tbhdirctl start [-i]\n\n' +
                '\tThis command will start the daemon. Install command will be ran before\n' +
                '\tstarting the daemon if -i is set.\n'
            )
            .then(() => {
                process.exit(0);
            });
    }

    /**
     * Stop command
     * @param {object} argv             Minimist object
     * @return {Promise}
     */
    helpStop(argv) {
        return this._app.info(
                'Usage:\tbhdirctl stop\n\n' +
                '\tThis command will stop the daemon\n'
            )
            .then(() => {
                process.exit(0);
            });
    }

    /**
     * Restart command
     * @param {object} argv             Minimist object
     * @return {Promise}
     */
    helpRestart(argv) {
        return this._app.info(
                'Usage:\tbhdirctl restart [-i]\n\n' +
                '\tThis command will stop and start the daemon. Install command will be ran after\n' +
                '\tstopping the daemon if -i is set.\n'
            )
            .then(() => {
                process.exit(0);
            });
    }

    /**
     * Status command
     * @param {object} argv             Minimist object
     * @return {Promise}
     */
    helpStatus(argv) {
        return this._app.info(
                'Usage:\tbhdirctl status\n\n' +
                '\tThis command will print daemon status\n'
            )
            .then(() => {
                process.exit(0);
            });
    }

    /**
     * Log error and terminate
     * @param {...*} args
     * @return {Promise}
     */
    error(...args) {
        if (args.length)
            args[args.length - 1] = args[args.length - 1] + '\n';

        return this._app.error(...args)
            .then(
                () => {
                    process.exit(1);
                },
                () => {
                    process.exit(1);
                }
            );
    }
}

module.exports = Help;