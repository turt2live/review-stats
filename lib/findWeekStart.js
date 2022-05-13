const moment = require("moment");

module.exports = function(date) { // moment
    return moment(date).subtract(date.day(), 'days'); // Sunday is zero, so find the last day of week
}