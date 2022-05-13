const {Liquid} = require("liquidjs");
const mkdirp = require("mkdirp");
const path = require("path");
const fs = require("fs");
const moment = require("moment");
const getPrs = require('./lib/getPrs');
const analyze = require("./lib/analyze");

module.exports = async function(orgName, repoName, teamName) {
    console.log("Generating for: ", {orgName, repoName, teamName});
    const { prs, hasCommunity } = await getPrs(orgName, repoName, teamName);

    const {
        metricsByWeek,
        coreByWeek,
        communityByWeek,
        incompleteByWeek,
        coreIncompleteByWeek,
        communityIncompleteByWeek,
        leastReviewCoreByWeek,
        leastReviewCommunityByWeek,
    } = await analyze(prs, hasCommunity, orgName, repoName, teamName);

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

    const renderCoreLeastReviewed = await engine.renderFile("least-reviewed.liquid", {
        orgName,
        repoName,
        teamName,
        group: 'core',
        data: leastReviewCoreByWeek,
        weekKeys: Object.keys(leastReviewCoreByWeek).sort().reverse(),
    });
    fs.writeFileSync(path.join(outDir, `core_least_reviewed.html`), renderCoreLeastReviewed);

    const renderCommunityLeastReviewed = await engine.renderFile("least-reviewed.liquid", {
        orgName,
        repoName,
        teamName,
        group: 'community',
        data: leastReviewCommunityByWeek,
        weekKeys: Object.keys(leastReviewCommunityByWeek).sort().reverse(),
    });
    fs.writeFileSync(path.join(outDir, `community_least_reviewed.html`), renderCommunityLeastReviewed);

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
