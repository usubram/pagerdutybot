'use strict';

const SlackBot = require('slack-quick-bots');
const handlebars = require('handlebars');
const path = require('path');
const fs = require('fs');
const template = fs.readFileSync(path.join(__dirname, 'template/oncall-template.hbs'), 'utf8');
const service = require('./lib/service');
const winston = require('winston');

const args = process.argv.slice(2);
const apikey = args[1];
const proxy = args[2];

var logger = new winston.Logger({
  level: 'info',
  transports: [
    new winston.transports.File({
      filename: 'log/pagerdutybot.log',
      timestamp: true
    })
  ]
});

var config = {
  bots: [{
    botCommand: {
      team: {
        commandType: 'DATA',
        allowedParam: ['*'],
        helpText: '    → _team <team-name>_ (full or part of team name)',
        template: function() {
          return handlebars.compile(template);
        },
        data: function(input, options, callback) {
          service.getTeams(input.params, apikey, function(err, data) {
            callback({ result: data });
          });
        }
      },
      escalation: {
        commandType: 'DATA',
        allowedParam: ['*'],
        helpText: '    → _escalation <escalation-name>_ (full or part of escalation name)',
        template: function() {
          return handlebars.compile(template);
        },
        data: function(input, options, callback) {
          service.getEscalations(input.params, apikey, function(err, data) {
            callback({ result: data });
          });
        }
      },
      oncall: {
        commandType: 'DATA',
        allowedParam: ['primary', 'secondary', 'all'],
        helpText: '    → _oncall primary <escalation-name>_ (full or part of escalation name)',
        template: function() {
          return handlebars.compile(template);
        },
        data: function(input, options, callback) {
          service.getOnCall(input.params, apikey, function(err, data) {
            callback({ result: data });
          });
        }
      },
      user: {
        commandType: 'DATA',
        allowedParam: ['*'],
        helpText: '    → _user <name or email>_',
        template: function() {
          return handlebars.compile(template);
        },
        data: function(input, options, callback) {
          service.getUserFromName(input.params, apikey, function(err, data) {
            callback({ result: data });
          });
        }
      }
    },
    schedule: true,
    botToken: args[0] || ''
  }],
  proxy: {
    url: proxy || ''
  },
  logger: logger
};

var slackBot = new SlackBot(config);
slackBot.start();
