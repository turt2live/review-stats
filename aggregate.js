const analyze = require("./lib/analyze");
const findWeekStart = require("./lib/findWeekStart");
const getPrs = require("./lib/getPrs");
const moment = require("moment");
const path = require("path");
const fs = require("fs");
const mkdirp = require("mkdirp");

async function aggregateTeam(teamName, repoRefs) {
    console.log(`Generating aggregated stats for ${teamName} in repos:`, repoRefs);

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

    const thisWeek = findWeekStart(moment()).format('YYYY-MM-DD');
    const lastWeek = findWeekStart(moment()).add(-1, 'week').format('YYYY-MM-DD');

    const template = {
        queueStart: 0,
        queueEnd: 0,
        queueMax: 0,
        queueVolume: 0,
        lagMin: Number.MAX_SAFE_INTEGER,
        lagMax: Number.MIN_SAFE_INTEGER,
        leastReviewed: {days: 0, prs: [/* "https://..." */]},
    };

    const statsLastWeek = {
        core: JSON.parse(JSON.stringify(template)),
        community: JSON.parse(JSON.stringify(template)),
    };
    const statsThisWeek = {
        core: JSON.parse(JSON.stringify(template)),
        community: JSON.parse(JSON.stringify(template)),
    };

    function ensureExists(week, obj) {
        if (!obj[week]) {
            obj[week] = {
                openToReviewRequest: [],
                reviewRequestToFirst: [],
                reviewRequestToApproved: [],
                queueSize: [],
            };
        }
    }

    for (const record of allStats) {
        ensureExists(lastWeek, record.coreByWeek);
        ensureExists(lastWeek, record.communityByWeek);
        ensureExists(thisWeek, record.coreByWeek);
        ensureExists(thisWeek, record.communityByWeek);

        const coreQueueLastWeek = record.coreByWeek[lastWeek]["queueSize"];
        const communityQueueLastWeek = record.communityByWeek[lastWeek]["queueSize"];
        const coreQueueThisWeek = record.coreByWeek[thisWeek]["queueSize"];
        const communityQueueThisWeek = record.communityByWeek[thisWeek]["queueSize"];

        mapQueueToObj(parseQueue(coreQueueLastWeek), statsLastWeek.core);
        mapQueueToObj(parseQueue(communityQueueLastWeek), statsLastWeek.community);
        mapQueueToObj(parseQueue(coreQueueThisWeek), statsThisWeek.core);
        mapQueueToObj(parseQueue(communityQueueThisWeek), statsThisWeek.community);

        statsLastWeek.core.queueVolume += record.coreByWeek[lastWeek]["openToReviewRequest"].length;
        statsLastWeek.community.queueVolume += record.communityByWeek[lastWeek]["openToReviewRequest"].length;
        statsThisWeek.core.queueVolume += record.coreByWeek[thisWeek]["openToReviewRequest"].length;
        statsThisWeek.community.queueVolume += record.communityByWeek[thisWeek]["openToReviewRequest"].length;

        statsLastWeek.core.lagMin = Math.min(statsLastWeek.core.lagMin, ...record.coreByWeek[lastWeek]["reviewRequestToFirst"]);
        statsLastWeek.community.lagMin = Math.min(statsLastWeek.community.lagMin, ...record.communityByWeek[lastWeek]["reviewRequestToFirst"]);
        statsThisWeek.core.lagMin = Math.min(statsThisWeek.core.lagMin, ...record.coreByWeek[thisWeek]["reviewRequestToFirst"]);
        statsThisWeek.community.lagMin = Math.min(statsThisWeek.community.lagMin, ...record.communityByWeek[thisWeek]["reviewRequestToFirst"]);

        statsLastWeek.core.lagMax = Math.max(statsLastWeek.core.lagMax, ...record.coreByWeek[lastWeek]["reviewRequestToFirst"]);
        statsLastWeek.community.lagMax = Math.max(statsLastWeek.community.lagMax, ...record.communityByWeek[lastWeek]["reviewRequestToFirst"]);
        statsThisWeek.core.lagMax = Math.max(statsThisWeek.core.lagMax, ...record.coreByWeek[thisWeek]["reviewRequestToFirst"]);
        statsThisWeek.community.lagMax = Math.max(statsThisWeek.community.lagMax, ...record.communityByWeek[thisWeek]["reviewRequestToFirst"]);

        mapLeastReviewedToObj(record.leastReviewCoreByWeek[lastWeek], statsLastWeek.core.leastReviewed);
        mapLeastReviewedToObj(record.leastReviewCommunityByWeek[lastWeek], statsLastWeek.community.leastReviewed);
        mapLeastReviewedToObj(record.leastReviewCoreByWeek[thisWeek], statsThisWeek.core.leastReviewed);
        mapLeastReviewedToObj(record.leastReviewCommunityByWeek[thisWeek], statsThisWeek.community.leastReviewed);
    }

    return { statsLastWeek, statsThisWeek };
}

function mapLeastReviewedToObj(leastRev, obj) {
    if (!leastRev) return;
    if (leastRev.days > obj.days) {
        obj.prs = leastRev.prs;
    } else if (leastRev.days === obj.days) {
        obj.prs = [...obj.prs, ...leastRev.prs];
    }
}

function mapQueueToObj(stats, obj) {
    obj.queueStart += stats.open;
    obj.queueEnd += stats.close;
    obj.queueMax += stats.max;
}

function parseQueue(week) {
    let open = 0;
    let close = 0;
    let max = Number.MIN_VALUE;
    let min = Number.MAX_VALUE;
    for (let i = 0; i < 7; i++) {
        let c = 0;
        for (const day of week) {
            const v = day[i];
            if (v === null) continue;
            if (v >= 0) {
                c++;
            } else {
                c--;
            }
        }
        if (i === 0) open = c;
        if (i === 6) close = c;
        max = Math.max(max, c);
        min = Math.min(min, c);
    }
    return {open, close, min, max};
}

function renderSection(stats) {
    const leastReviewedList = stats.leastReviewed.prs.map(pr => {
        const shorthand = pr.replace(/https:\/\/github.com\/[^\/]*\//, '').replace('/pull/', '#');
        return `<li><a href="${pr}">${shorthand}</a></li>`;
    })

    return ""
        + `<li>Queue size: Started at ${stats.queueStart}, ended at ${stats.queueEnd}. Max ${stats.queueMax}. Volume ${stats.queueVolume}.</li>`
        + `<li>Review lag: ${stats.queueVolume <= 0 ? "No PRs to review." : `${stats.lagMin} - ${stats.lagMax} calendar days`}</li>`
        + `<li>Least reviewed PRs: ${stats.leastReviewed.prs.length}-way tie at ${stats.leastReviewed.days} calendar days.<ul>${leastReviewedList.join('')}</ul></li>`;
}

module.exports = async function(teamName, repos) {
    const { statsLastWeek, statsThisWeek } = await aggregateTeam(teamName, repos);

    const htmlOutDir = "html";
    const outDir = path.join(htmlOutDir, "_weeklysync", teamName);
    mkdirp.sync(outDir);

    const output = ""
        + `<ul><li>Core team PRs:<ul><li>Last week (finalized):<ul>${renderSection(statsLastWeek.core)}</ul></li>`
        + `<li>This week (so far):<ul>${renderSection(statsThisWeek.core)}</ul></li></ul>`
        + `<li>Community PRs:<ul><li>Last week (finalized):<ul>${renderSection(statsLastWeek.community)}</ul></li>`
        + `<li>This week (so far):<ul>${renderSection(statsThisWeek.community)}</ul></li></ul>`;

    fs.writeFileSync(path.join(outDir, "summary.html"), output, "utf-8");
};
