let auth = {token: process.env['GH_PAT']};
if (!auth.token) {
    auth = require("../auth.json");
}

module.exports = auth;