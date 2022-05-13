const path = require("path");
const fs = require("fs");
const moment = require("moment");
const findWeekStart = require("./findWeekStart");

module.exports = async function(prs, hasCommunity, orgName, repoName, teamName) {
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

    const leastReviewCoreByWeek = {};
    const leastReviewCommunityByWeek = {};

    const ghFormat = "YYYY-MM-DDTHH:mm:ssZ";

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
        let firstReview = events.find(e => e['__typename'] === 'PullRequestReview' && e['onBehalfOf'] && e['onBehalfOf']['edges'] && e['onBehalfOf']['edges'].map(d => d['node']).filter(n => !!n).find(n => n['name'] === teamName));
        let approvingReview = events.find(e => e['__typename'] === 'PullRequestReview' && e['state'] === 'APPROVED' && e['onBehalfOf'] && e['onBehalfOf']['edges'] && e['onBehalfOf']['edges'].map(d => d['node']).filter(n => !!n).find(n => n['name'] === teamName));
        const lastRemoved = events.filter(e => e['__typename'] === 'ReviewRequestRemovedEvent' && e['requestedReviewer'] && e['requestedReviewer']['name'] === teamName).sort((a, b) => (a < b) ? 1 : ((a === b) ? 0 : -1))[0];

        if (!reviewRequest) continue;
        let incomplete = !firstReview || !approvingReview;

        // Consider last removed review request as the (incomplete) review date if needed
        if (!approvingReview && lastRemoved && lastRemoved['createdAt'] > (firstReview ? firstReview['createdAt'] : '')) {
            approvingReview = lastRemoved;
            if (!firstReview) firstReview = lastRemoved;
        }

        // Count merged without review as reviewed on the merge date
        if (incomplete && pr['state'] === 'MERGED') {
            if (!firstReview) firstReview = {createdAt: pr['closedAt']};
            if (!approvingReview) approvingReview = {createdAt: pr['closedAt']};
            incomplete = false;
        }

        const requestDate = moment.utc(reviewRequest['createdAt'], ghFormat);
        const firstDate = (incomplete && !firstReview) ? moment.utc() : moment.utc(firstReview['createdAt'], ghFormat);
        const approvedDate = (incomplete && !approvingReview) ? moment.utc() : moment.utc(approvingReview['createdAt'], ghFormat);

        const week = findWeekStart(requestDate);
        const key = week.format('YYYY-MM-DD');
        const keyLeastReview = findWeekStart(requestDate).format('YYYY-MM-DD');

        const mainMetrics = incomplete ? incompleteByWeek : metricsByWeek;
        const groupedByWeek = (pr["authorAssociation"] === 'MEMBER' || !hasCommunity)
            ? (incomplete ? coreIncompleteByWeek : coreByWeek)
            : (incomplete ? communityIncompleteByWeek : communityByWeek);
        const leastReviewByWeek = (pr["authorAssociation"] === 'MEMBER' || !hasCommunity)
            ? leastReviewCoreByWeek
            : leastReviewCommunityByWeek;
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
        if (!leastReviewByWeek[keyLeastReview]) {
            leastReviewByWeek[keyLeastReview] = {
                prs: [],
                days: -1,
            };
        }

        mainMetrics[key].openToReviewRequest.push(requestDate.diff(createdDate, 'days'));
        mainMetrics[key].reviewRequestToFirst.push(firstDate.diff(requestDate, 'days'));
        mainMetrics[key].reviewRequestToApproved.push(approvedDate.diff(requestDate, 'days'));

        groupedByWeek[key].openToReviewRequest.push(requestDate.diff(createdDate, 'days'));
        groupedByWeek[key].reviewRequestToFirst.push(firstDate.diff(requestDate, 'days'));
        groupedByWeek[key].reviewRequestToApproved.push(approvedDate.diff(requestDate, 'days'));

        if (pr['state'] !== 'CLOSED') {
            const daysStuck = firstDate.diff(requestDate, 'days');
            if (leastReviewByWeek[keyLeastReview].days < daysStuck) {
                leastReviewByWeek[keyLeastReview].prs = [pr['url']];
                leastReviewByWeek[keyLeastReview].days = daysStuck;
            } else if (leastReviewByWeek[keyLeastReview].days === daysStuck) {
                leastReviewByWeek[keyLeastReview].prs.push(pr['url']);
            }
        }
    }

    fs.writeFileSync(path.join('tmp', `byweek.${orgName}.${repoName}.json`), JSON.stringify(metricsByWeek, null, 4));
    fs.writeFileSync(path.join('tmp', `byweek.core.${orgName}.${repoName}.json`), JSON.stringify(coreByWeek, null, 4));
    fs.writeFileSync(path.join('tmp', `byweek.community.${orgName}.${repoName}.json`), JSON.stringify(communityByWeek, null, 4));

    fs.writeFileSync(path.join('tmp', `byweek.incomplete.${orgName}.${repoName}.json`), JSON.stringify(incompleteByWeek, null, 4));
    fs.writeFileSync(path.join('tmp', `byweek.incomplete.core.${orgName}.${repoName}.json`), JSON.stringify(coreIncompleteByWeek, null, 4));
    fs.writeFileSync(path.join('tmp', `byweek.incomplete.community.${orgName}.${repoName}.json`), JSON.stringify(communityIncompleteByWeek, null, 4));

    fs.writeFileSync(path.join('tmp', `byweek.core.leastreview.${orgName}.${repoName}.json`), JSON.stringify(leastReviewCoreByWeek, null, 4));
    fs.writeFileSync(path.join('tmp', `byweek.community.leastreview.${orgName}.${repoName}.json`), JSON.stringify(leastReviewCommunityByWeek, null, 4));

    return {
        metricsByWeek,
        coreByWeek,
        communityByWeek,
        incompleteByWeek,
        coreIncompleteByWeek,
        communityIncompleteByWeek,
        leastReviewCoreByWeek,
        leastReviewCommunityByWeek,
    };
}