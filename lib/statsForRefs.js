const getPrs = require("./getPrs");
const analyze = require("./analyze");

module.exports = async function(teamName, repoRefs) {
    const allStats = [];
    for (const ref of repoRefs) {
        const [orgName, repoName] = ref.split('/');
        const { prs, hasCommunity } = await getPrs(orgName, repoName, teamName);
        const stats = await analyze(prs, hasCommunity, orgName, repoName, teamName);
        allStats.push({
            orgName,
            repoName,
            teamName,
            prs,
            hasCommunity,
            ...stats,
        });
    }
    return allStats;
}
