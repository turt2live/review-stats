const {graphql} = require("@octokit/graphql");
const repoPrs = require("../queries/repo-prs");
const path = require("path");
const fs = require("fs");
const auth = require('./auth');

module.exports = async function(orgName, repoName, teamName) {
    console.log(`Getting PRs for ${orgName}/${repoName} and team ${teamName}`);

    const tmpFile = path.join('tmp', `tmp.${orgName}.${repoName}.json`);
    const prs = [];
    let hasCommunity = true;
    if (fs.existsSync(tmpFile)) {
        const data = JSON.parse(fs.readFileSync(tmpFile));
        prs.push(...data['prs']);
        hasCommunity = data.hasCommunity !== false;
    } else {
        let lastId = null;
        while (true) {
            console.log(`Getting prs starting at ${lastId}`);
            const {repository} = await graphql(repoPrs(orgName, repoName, lastId), {
                headers: {
                    authorization: `token ${auth.token}`,
                },
            });
            const nodes = repository['pullRequests']['edges'];
            prs.push(...(nodes.map(e => e['node'])));
            if (nodes.length === 0) break;
            lastId = nodes[nodes.length - 1]['cursor'];
            if (repository.isPrivate) {
                hasCommunity = false;
            }
        }
    }

    fs.writeFileSync(tmpFile, JSON.stringify({prs, hasCommunity}, null, 4));

    return {prs, hasCommunity};
};