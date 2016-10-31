'use strict';

const _ = require('lodash');
const async = require("async");
const http = require('https');

const pagerdutyApi = 'api.pagerduty.com';
const concurrentRate = 3;
const searchLimit = 3;
const internals = {
  apiKey: ''
};

var requestQueue = {};

module.exports.getTeams = function (params, apiKey, callback) {
  internals.apiKey = apiKey;
  const searchKey = encodeURIComponent(_.trim(_.join(params, ' ')));
  internals.queueCall(internals.fetchTeams(searchKey), function (err, result) {
    if (err || _.get(result, 'teams', []).length === 0) {
      return callback(null, { not_found: true })
    }
    callback(null, result);
  });
};

module.exports.getEscalations = function (params, apiKey, callback) {
  internals.apiKey = apiKey;
  const searchKey = encodeURIComponent(_.trim(_.join(params, ' ')));
  internals.queueCall(internals.fetchEscalations(searchKey), function (err, result) {
    if (err || _.get(result, 'escalation_policies', []).length === 0) {
      return callback(null, { not_found: true })
    }
    callback(null, result);
  });
};

module.exports.getOnCall = function (params, apiKey, callback) {
  internals.apiKey = apiKey;
  const searchKey = encodeURIComponent(_.trim(_.join(params, ' ')));
  async.waterfall([
    function (wfCallback) {
      internals.getEscalationPolicies(searchKey, wfCallback);
    },
    internals.getOnCallUsers,
    internals.getUserContacts,
  ], function (err, result) {
    if (err) {
      return callback(null, err);
    }
    callback(null, result);
  });
};

internals.getEscalationPolicies = function (searchKey, callback) {
  internals.queueCall(internals.fetchEscalations(searchKey), function (err, escalationResult) {
    if (err) {
      return callback({ not_found: true });
    }

    const escalationResultLen = _.get(escalationResult, 'escalation_policies', []).length;
    if (escalationResultLen === 0) {
      return callback({ not_found: true });
    } else {
      return callback(null, _.take(escalationResult.escalation_policies, searchLimit));
    }
  });
};

internals.getOnCallUsers = function (escalationPolicies, callback) {
  let onCallResult = {};
  async.map(escalationPolicies, function(item, asyncCallback) {
    onCallResult[item.id] = item;
    onCallResult[item.id].oncall = [];

    internals.queueCall(internals.fetchOnCall(item.id), asyncCallback);
  }, function(err, results) {
    if (err) {
      return callback({ not_found: true });
    }

    _.each(results, function (result) {
      let onCallUsers = _.map(_.sortBy(result.oncalls, ['escalation_level']), 'user');
      onCallResult[result.oncalls[0].escalation_policy.id].oncall = _.keyBy(onCallUsers, function (user) {
        return user.id;
      });
    });
    return callback(null, onCallResult);
  });
};

internals.getUserContacts = function (onCallResult, callback) {
  let userIds = _.uniq(_.flatten(_.map(_.values(onCallResult), function (item) {
    return _.keys(item.oncall);
  })));

  async.map(userIds, function(userId, asyncCallback) {
    internals.queueCall(internals.fetchUser([userId]), asyncCallback);
  }, function(err, results) {
    if (err) {
      return callback({ not_found: true });
    }
    let keyUserData = internals.writeLabels(_.keyBy(_.map(results, 'user'), function (user) {
      return user.id;
    }));
    _.each(keyUserData, function (value, key) {
      _.each(onCallResult, function (onCall) {
        if (onCall.oncall[key]) {
          onCall.oncall[key] = value;
        }
      });
    });
    return callback(null, _.values(onCallResult));
  });
};

internals.queueCall = function (requestOptions, callback) {
  requestQueue.push({
    task: {
      options: requestOptions,
      callback: callback
    }
  }, function (err) {
    console.log('queue processed');
  });
};

internals.callApi = function (config, queueCallback) {
  const req = http.request(config.task.options, function(response) {
    var responseStr = '';
    response.on('data', function(chunk) {
      responseStr += chunk;
    });
    response.on('end', function() {
      var responseObj = {};
      try {
        responseObj = JSON.parse(responseStr);
      } catch (err) {
        return queueCallback(err);
      }
      config.task.callback(null, responseObj);
      queueCallback();
    });
  });

  req.end();
};

internals.createRequestQueue = function (concurrentRate) {
  return async.queue(internals.callApi, concurrentRate);
};

internals.fetchTeams = function (teamSearchKeyword) {
  const options = {
    host: pagerdutyApi,
    path: '/teams?query=' + teamSearchKeyword,
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Token token='+ internals.apiKey,
      'Accept': 'application/vnd.pagerduty+json;version=2'
    },
    rejectUnauthorized : false
  };
  return options;
};

internals.fetchEscalations = function (escalationSearchKeyword) {
  const options = {
    host: pagerdutyApi,
    path: '/escalation_policies?include[]=services&include[]=teams&sort_by=name&query=' + escalationSearchKeyword,
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Token token='+ internals.apiKey,
      'Accept': 'application/vnd.pagerduty+json;version=2'
    },
    rejectUnauthorized : false
  };
  return options;
};

internals.fetchOnCall = function (escalationPolicyId) {
  const options = {
    host: pagerdutyApi,
    path: '/oncalls?time_zone=UTC&include[]=users&escalation_policy_ids[]='+ escalationPolicyId,
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Token token='+ internals.apiKey,
      'Accept': 'application/vnd.pagerduty+json;version=2'
    },
    rejectUnauthorized : false
  };
  return options;
};

internals.fetchUser = function (params) {
  const userId = _.nth(params, 0);
  const options = {
    host: pagerdutyApi,
    path: '/users/'+ userId + '?include[]=contact_methods',
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Token token='+ internals.apiKey,
      'Accept': 'application/vnd.pagerduty+json;version=2'
    },
    rejectUnauthorized : false
  };
  return options;
};

internals.writeLabels = function (usersData) {
  return _.reduce(usersData, function (result, value, key) {
    value.contact_methods = _.map(value.contact_methods , function (contact) {
      if (contact.type === 'email_contact_method') {
        contact.label = 'Email';
      } else if (contact.type === 'phone_contact_method') {
        contact.label = 'Phone';
      } else if (contact.type === 'sms_contact_method') {
        contact.label = 'Text';
      } else {
        contact = {};
      }
      return contact;
    });
    result[key] = value;
    return result;
  }, {});
};

requestQueue = internals.createRequestQueue(concurrentRate);
