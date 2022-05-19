const auth = require("./lib/auth");
const statsForRefs = require("./lib/statsForRefs");
const moment = require("moment");
const {Octokit} = require("@octokit/core");
const {Liquid} = require("liquidjs");
const mkdirp = require("mkdirp");
const path = require("path");
const fs = require("fs");

const octokit = new Octokit({
    auth: auth.token,
});

async function getTeamMembers(orgName, teamName) {
    return octokit.request('GET /orgs/{org}/teams/{team_slug}/members', {
        org: orgName,
        team_slug: teamName,
    });
}

function mapStatsToMonth(byWeek, byMonth) {
    for (const [week, {reviewers}] of Object.entries(byWeek)) {
        const ts = moment.utc(week, 'YYYY-MM-DD');
        const month = ts.format('MMMM YYYY');
        if (!byMonth[month]) byMonth[month] = {};
        for (const [login, count] of Object.entries(reviewers)) {
            if (!byMonth[month][login]) byMonth[month][login] = 0;
            byMonth[month][login] += count;
        }
    }
}

async function pickOutStats(teamName, repoRefs) {
    console.log(`Generating leaderboard stats for ${teamName} in repos:`, repoRefs);

    const allStats = await statsForRefs(teamName, repoRefs);
    const coreByMonth = {}; // { month: { reviewer: count } }
    const communityByMonth = {}; // { month: { reviewer: count } }
    for (const stats of allStats) {
        const { coreByWeek, communityByWeek } = stats;
        mapStatsToMonth(coreByWeek, coreByMonth);
        mapStatsToMonth(communityByWeek, communityByMonth);
    }

    return { coreByMonth, communityByMonth };
}

async function polyfillStats(month, members) {
    for (const key of Object.keys(month)) {
        for (const member of members) {
            if (!month[key][member]) month[key][member] = 0;
        }
    }
}

async function appendKeyOrder(month) {
    const keys = Array.from(Object.keys(month)).map(k => [k, moment.utc(k, 'MMMM YYYY').unix()]);
    keys.sort((a, b) => b[1] - a[1]);
    month._keyOrder = keys.map(k => k[0]);

    const allLogins = new Set();
    for (const [key, reviews] of Object.entries(month)) {
        for (const login of Object.keys(reviews)) {
            allLogins.add(login);
        }
    }
    const logins = Array.from(allLogins).map(k => [k, k.toLowerCase()]);
    logins.sort((a, b) => a[1].localeCompare(b[1]));
    month._loginKeyOrder = logins.map(k => k[0]);
}

async function combineOnto(month, combined, designation) {
    for (const [monthKey, stats] of Object.entries(month)) {
        if (!combined[monthKey]) combined[monthKey] = {};
        for (const [login, count] of Object.entries(stats)) {
            if (!combined[monthKey][login]) combined[monthKey][login] = {};
            combined[monthKey][login][designation] = count;
        }
    }
}

module.exports = async function(teamName, repos) {
    const orgNames = Array.from(new Set(repos.map(r => r.split('/')[0])));

    const { coreByMonth, communityByMonth } = await pickOutStats(teamName, repos);

    const teamMembers = new Set();
    for (const orgName of orgNames) {
        console.log(`Getting team members for @${orgName}/${teamName}`);
        const members = (await getTeamMembers(orgName, teamName)).data;
        members.forEach(m => {
            teamMembers.add(m.login);
        });
    }

    await polyfillStats(coreByMonth, Array.from(teamMembers));
    await polyfillStats(communityByMonth, Array.from(teamMembers));

    // Combine the two into a single object (for ease)
    const combined = {};
    await combineOnto(coreByMonth, combined, 'core');
    await combineOnto(communityByMonth, combined, 'community');

    // To make exporting easier, sort the date keys now (newest first)
    await appendKeyOrder(combined);

    const engine = new Liquid({root: './templates'});
    const htmlOutDir = "html";
    const outDir = path.join(htmlOutDir, "_weeklysync", teamName);
    mkdirp.sync(outDir);

    const leaderboard = await engine.renderFile("leaderboard.liquid", {
        combined,
        teamName,
        repos: JSON.stringify(repos),
    });
    fs.writeFileSync(path.join(outDir, "leaderboard.html"), leaderboard);

    console.log("Done!");
};