const {graphql} = require("@octokit/graphql");
const repoPrs = require("./queries/repo-prs");
const {Liquid} = require("liquidjs");
const path = require("path");
const fs = require("fs");
const mkdirp = require("mkdirp");
const moment = require("moment");

let auth = {token: process.env['GH_PAT']};
if (!auth.token) {
    auth = require("./auth.json");
}

module.exports = async function(orgName, repoName, teamName) {
    console.log("Generating for: ", {orgName, repoName, teamName});
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

    // Metrics:
    // Queue size by week
    // Time from Open -> Review Request
    // Time from Review Request -> First Review
    // Time from Review Request -> Approving Review

    const metricsByWeek = { // "week" starts on the Sunday and is the day the first review request is made
        // [YYYY-MM-DD]: {
        //     "queueSize": [[change in days]],
        //     "openToReviewRequest": [# days],
        //     "reviewRequestToFirst": [# days],
        //     "reviewRequestToApproved": [# days],
        // }
    };
    const coreByWeek = {};
    const communityByWeek = {};
    const incompleteByWeek = {};
    const coreIncompleteByWeek = {};
    const communityIncompleteByWeek = {};

    const ghFormat = "YYYY-MM-DDTHH:mm:ssZ"

    function findWeekStart(date) { // moment
        return moment(date).subtract(date.day(), 'days'); // Sunday is zero, so find the last day of week
    }

    for (const pr of prs) {
        const createdDate = moment(pr['createdAt'], ghFormat);
        const events = pr['timelineItems']['edges'].map(e => e['node']);

        const reviewRequests = events.filter(e => e['__typename'] === 'ReviewRequestedEvent' && e['requestedReviewer'] && e['requestedReviewer']['name'] === teamName);
        const delistedEvents = [
            ...events.filter(e => e['__typename'] === 'PullRequestReview' && e['onBehalfOf'] && e['onBehalfOf']['edges'] && e['onBehalfOf']['edges'].map(d => d['node']).filter(n => !!n && n['name'] === teamName)),
            ...events.filter(e => e['__typename'] === 'ReviewRequestRemovedEvent' && e['requestedReviewer'] && e['requestedReviewer']['name'] === teamName),
            ...events.filter(e => e['__typename'] === 'ClosedEvent' || e['__typename'] === 'MergedEvent'),
        ];
        delistedEvents.sort((a, b) => {
            const aDate = moment.utc(a['createdAt'], ghFormat);
            const bDate = moment.utc(b['createdAt'], ghFormat);
            return aDate.diff(bDate, 'days');
        });

        for (const req of reviewRequests) {
            const reqDate = moment.utc(req['createdAt'], ghFormat);
            const nextRemove = delistedEvents.find(e => reqDate.isSameOrBefore(moment.utc(e['createdAt'], ghFormat)));
            const nextRemoveDate = nextRemove ? moment.utc(nextRemove['createdAt'], ghFormat) : moment.utc();

            let mark = reqDate.clone();
            const weekArrays = [[]];
            let currentWeek = weekArrays[0];
            let currentWeekLabel = findWeekStart(mark).format('YYYY-MM-DD');
            do {
                const week = findWeekStart(mark);
                const dayIdx = mark.diff(week, 'days');

                if (currentWeekLabel !== week.format('YYYY-MM-DD')) {
                    while (currentWeek.length < 7) {
                        currentWeek.push(null);
                    }
                    weekArrays.push([]);
                    currentWeek = weekArrays[weekArrays.length - 1];
                    currentWeekLabel = week.format('YYYY-MM-DD');
                }

                while (currentWeek.length < dayIdx) {
                    currentWeek.push(null);
                }

                const num = mark.diff(nextRemoveDate, 'days') === 0 && mark.diff(reqDate, 'days') === 0
                    ? 0
                    : (mark.diff(nextRemoveDate, 'days') === 0 ? -1 : 1);
                currentWeek.push(num);
            } while(mark.add(1, 'days').diff(nextRemoveDate, 'days') < 0);

            while (currentWeek.length < 7) {
                currentWeek.push(null);
            }

            mark = findWeekStart(reqDate).clone();
            const teamMetrics = (pr["authorAssociation"] === 'MEMBER' || !hasCommunity) ? coreByWeek : communityByWeek;
            for (const week of weekArrays) {
                const key = mark.format('YYYY-MM-DD');
                if (!metricsByWeek[key]) {
                    metricsByWeek[key] = {
                        openToReviewRequest: [],
                        reviewRequestToFirst: [],
                        reviewRequestToApproved: [],
                        queueSize: [],
                    };
                }
                if (!teamMetrics[key]) {
                    teamMetrics[key] = {
                        openToReviewRequest: [],
                        reviewRequestToFirst: [],
                        reviewRequestToApproved: [],
                        queueSize: [],
                    };
                }
                metricsByWeek[key].queueSize.push(week);
                teamMetrics[key].queueSize.push(week);
                mark = mark.add(1, 'week');
            }
        }

        const reviewRequest = events.find(e => e['__typename'] === 'ReviewRequestedEvent' && e['requestedReviewer'] && e['requestedReviewer']['name'] === teamName);
        const firstReview = events.find(e => e['__typename'] === 'PullRequestReview' && e['onBehalfOf'] && e['onBehalfOf']['edges'] && e['onBehalfOf']['edges'].map(d => d['node']).filter(n => !!n).find(n => n['name'] === teamName));
        const approvingReview = events.find(e => e['__typename'] === 'PullRequestReview' && e['state'] === 'APPROVED' && e['onBehalfOf'] && e['onBehalfOf']['edges'] && e['onBehalfOf']['edges'].map(d => d['node']).filter(n => !!n).find(n => n['name'] === teamName));

        if (!reviewRequest) continue;
        const incomplete = !firstReview || !approvingReview;

        const requestDate = moment.utc(reviewRequest['createdAt'], ghFormat);
        const firstDate = incomplete ? moment.utc() : moment.utc(firstReview['createdAt'], ghFormat);
        const approvedDate = incomplete ? moment.utc() : moment.utc(approvingReview['createdAt'], ghFormat);

        const week = findWeekStart(requestDate);
        const key = week.format('YYYY-MM-DD');

        const mainMetrics = incomplete ? incompleteByWeek : metricsByWeek;
        const groupedByWeek = (pr["authorAssociation"] === 'MEMBER' || !hasCommunity)
            ? (incomplete ? coreIncompleteByWeek : coreByWeek)
            : (incomplete ? communityIncompleteByWeek : communityByWeek);
        if (!mainMetrics[key]) {
            mainMetrics[key] = {
                openToReviewRequest: [],
                reviewRequestToFirst: [],
                reviewRequestToApproved: [],
                queueSize: [],
            };
        }
        if (!groupedByWeek[key]) {
            groupedByWeek[key] = {
                openToReviewRequest: [],
                reviewRequestToFirst: [],
                reviewRequestToApproved: [],
                queueSize: [],
            };
        }

        mainMetrics[key].openToReviewRequest.push(requestDate.diff(createdDate, 'days'));
        mainMetrics[key].reviewRequestToFirst.push(firstDate.diff(requestDate, 'days'));
        mainMetrics[key].reviewRequestToApproved.push(approvedDate.diff(requestDate, 'days'));

        groupedByWeek[key].openToReviewRequest.push(requestDate.diff(createdDate, 'days'));
        groupedByWeek[key].reviewRequestToFirst.push(firstDate.diff(requestDate, 'days'));
        groupedByWeek[key].reviewRequestToApproved.push(approvedDate.diff(requestDate, 'days'));
    }

    fs.writeFileSync(path.join('tmp', `byweek.${orgName}.${repoName}.json`), JSON.stringify(metricsByWeek, null, 4));
    fs.writeFileSync(path.join('tmp', `byweek.core.${orgName}.${repoName}.json`), JSON.stringify(coreByWeek, null, 4));
    fs.writeFileSync(path.join('tmp', `byweek.community.${orgName}.${repoName}.json`), JSON.stringify(communityByWeek, null, 4));

    fs.writeFileSync(path.join('tmp', `byweek.incomplete.${orgName}.${repoName}.json`), JSON.stringify(incompleteByWeek, null, 4));
    fs.writeFileSync(path.join('tmp', `byweek.incomplete.core.${orgName}.${repoName}.json`), JSON.stringify(coreIncompleteByWeek, null, 4));
    fs.writeFileSync(path.join('tmp', `byweek.incomplete.community.${orgName}.${repoName}.json`), JSON.stringify(communityIncompleteByWeek, null, 4));

    const engine = new Liquid({root: './templates'});
    const htmlOutDir = "html";
    const outDir = path.join(htmlOutDir, orgName, repoName, teamName);
    mkdirp.sync(outDir);

    const renders = [
        ["All PRs", "", metricsByWeek],
        ["Core Team PRs", "core", coreByWeek],
        ["Community PRs", "community", communityByWeek],
        ["All PRs (Never Approved)", "incomplete", incompleteByWeek],
        ["Core Team PRs (Never Approved)", "incomplete-core", coreIncompleteByWeek],
        ["Community PRs (Never Approved)", "incomplete-community", communityIncompleteByWeek],
    ];

    for (const r of renders) {
        const group = r[0];
        const shortcode = r[1];
        const groupedByWeek = r[2];
        const isComplete = !shortcode.startsWith("incomplete");

        const filePrefix = shortcode ? (shortcode + '-') : '';

        const allTimeFname = `${filePrefix}all_time.html`;
        console.log(`Rendering ${allTimeFname}`);
        let result = await engine.renderFile("graphs.liquid", {
            orgName,
            repoName,
            teamName,
            group,
            isComplete,
            rawData: JSON.stringify(groupedByWeek),
        });
        fs.writeFileSync(path.join(outDir, allTimeFname), result);

        const sep06 = moment('2020-09-05', 'YYYY-MM-DD'); // 1 day before sept 6 to include the week of sep 6
        const keysToInclude = Object.keys(groupedByWeek).map(w => moment(w, 'YYYY-MM-DD')).filter(w => w.isAfter(sep06)).map(w => w.format('YYYY-MM-DD'));
        const limitedMetricsByDate = {};
        for (const k of keysToInclude) {
            limitedMetricsByDate[k] = groupedByWeek[k];
        }
        const sinceFname = `${filePrefix}since_sep06_2020.html`;
        console.log(`Rendering ${sinceFname}`);
        result = await engine.renderFile("graphs.liquid", {
            orgName,
            repoName,
            teamName,
            group,
            isComplete,
            rawData: JSON.stringify(limitedMetricsByDate),
        });
        fs.writeFileSync(path.join(outDir, sinceFname), result);
    }

    // Copy assets
    const assetPath = "res";
    const assets = fs.readdirSync(assetPath);
    const outAssets = path.join(htmlOutDir, assetPath);
    mkdirp.sync(outAssets);
    for (const asset of assets) {
        const f = path.join(assetPath, asset);
        console.log("Copying to output: ", f);
        fs.writeFileSync(path.join(outAssets, asset), fs.readFileSync(f));
    }

    // Make an index
    const partialsByTeam = {
        // [teamName]: html
    };
    const orgNames = fs.readdirSync(htmlOutDir).filter(f => f !== assetPath && fs.statSync(path.join(htmlOutDir, f)).isDirectory());
    for (const org of orgNames) {
        const projects = fs.readdirSync(path.join(htmlOutDir, org));
        for (const project of projects) {
            const teams = fs.readdirSync(path.join(htmlOutDir, org, project));
            for (const team of teams) {
                if (!partialsByTeam[team]) partialsByTeam[team] = "";
                console.log(`Rendering partial for ${org}/${project} @ ${team}`);
                const r = await engine.renderFile("repo-project-team.partial.liquid", {
                    orgName: org,
                    projectName: project,
                    teamName: team,
                });
                partialsByTeam[team] += r;
            }
        }
    }
    const implicitTeamOrder = ["element-web", "Design", "Product"];
    const partialHtmlCombined = Object.keys(partialsByTeam).sort((a, b) => {
        let idxA = implicitTeamOrder.indexOf(a);
        let idxB = implicitTeamOrder.indexOf(b);
        if (idxA < 0) idxA = implicitTeamOrder.length;
        if (idxB < 0) idxB = implicitTeamOrder.length;

        const r = idxA - idxB;
        if (r !== 0) return r;
        return a.toLowerCase().localeCompare(b.toLowerCase());
    }).map(t => partialsByTeam[t]).join("<hr />");

    console.log("Rendering index.html");
    const index = await engine.renderFile("index.liquid", {partialHtmlCombined});
    fs.writeFileSync(path.join(htmlOutDir, "index.html"), index);

    console.log("Done!");
};
