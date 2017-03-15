/**
 * Installation specific application configuration
 */
const path = require('path');

module.exports = {
    // Server instance name (alphanumeric)
    instance: 'server1',

    // Environment
    env: process.env.NODE_ENV || 'production',

    // Loaded modules
    modules: [
    ],

    // Servers
    servers: {
    },

    // SMTP servers
    smtp: {
        main: {
            host: 'localhost',
            port: 25,
            ssl: false,
            //user: 'username',
            //password: 'password',
        },
    },

    email: {
        from: 'root@localhost',
        logger: {
            info_enabled: false,            // email logger.info() or not
            warn_enabled: false,            // email logger.warn() or not
            error_enabled: false,           // email logger.error() or not
            to: 'debug@example.com',
        },
        daemon: {
            enabled: false,                 // email program crash or not
            to: 'debug@example.com',
        },
    },

    logs: {
        main: {
            default: true,
            name: 'bhdir.log',
            path: '/var/log/bhdir',
            interval: '1d',
            mode: 0o640,
        },
    },

/*
    user: { // Drop privileges, otherwise comment out this section
        uid: 'www',
        gid: 'www',
    },
*/
};