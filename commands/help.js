/**
 * Help command
 * @module commands/help
 */
const debug = require('debug')('bhdir:command');

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

        method.call(this, argv);
        return Promise.resolve();
    }

    /**
     * General help
     */
    usage() {
        console.log('Usage:\tbhdirctl <command> [<parameters]');
        console.log('Commands:');
        console.log('\thelp\t\tPrint help about any other command');
        console.log('\tinstall\t\tRegister the program in the system');
        console.log('\tget\t\tGet variable value');
        console.log('\tstart\t\tStart the daemon');
        console.log('\tstop\t\tStop the daemon');
        console.log('\trestart\t\tRestart the daemon');
        console.log('\tstatus\t\tQuery running status of the daemon');
        process.exit(0);
    }

    /**
     * Help command
     */
    helpHelp(argv) {
        console.log('Usage:\tbhdirctl help <command>\n');
        console.log('\tPrint help for the given command');
        process.exit(0);
    }

    /**
     * Install command
     */
    helpInstall(argv) {
        console.log('Usage:\tbhdirctl install\n');
        console.log('\tThis command will register the program in the system');
        console.log('\tand will create configuration in /etc/bhid by default');
        process.exit(0);
    }

    /**
     * Get command
     */
    helpGet(argv) {
        console.log('Usage:\tbhdirctl get <path>\n');
        console.log('\tGet variable value');
        process.exit(0);
    }

    /**
     * Start command
     */
    helpStart(argv) {
        console.log('Usage:\tbhdirctl start [-i]\n');
        console.log('\tThis command will start the daemon. Install command will be ran before');
        console.log('\tstarting the daemon if -i is set.');
        process.exit(0);
    }

    /**
     * Stop command
     */
    helpStop(argv) {
        console.log('Usage:\tbhdirctl stop\n');
        console.log('\tThis command will stop the daemon');
        process.exit(0);
    }

    /**
     * Restart command
     */
    helpRestart(argv) {
        console.log('Usage:\tbhdirctl restart [-i]\n');
        console.log('\tThis command will stop and start the daemon. Install command will be ran after');
        console.log('\tstopping the daemon if -i is set.');
        process.exit(0);
    }

    /**
     * Status command
     */
    helpStatus(argv) {
        console.log('Usage:\tbhdirctl status\n');
        console.log('\tThis command will print daemon status');
        process.exit(0);
    }

    /**
     * Log error and terminate
     * @param {...*} args
     */
    error(...args) {
        console.error(...args);
        process.exit(1);
    }
}

module.exports = Help;