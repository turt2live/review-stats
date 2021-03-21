module.exports = function repoPrs(owner, name, after) {
    // This form of templating is dangerous, but the user
    // running this should know better.
    return `
    {
        repository(owner: "${owner}", name: "${name}") {
            isPrivate
            pullRequests(first: 100${after ? ` after: "${after}"` : ""}) {
                edges {
                    cursor
                    node {
                        id
                        timelineItems(first: 25, itemTypes: [PULL_REQUEST_REVIEW, REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT]) {
                            edges {
                                node {
                                    ... on PullRequestReview {
                                        __typename
                                        createdAt
                                        updatedAt
                                        state
                                        submittedAt
                                        author {
                                            login
                                        }
                                        authorAssociation
                                        onBehalfOf(first: 2) {
                                            edges {
                                                node {
                                                    name
                                                }
                                            }
                                        }
                                    }

                                    ... on ReviewRequestedEvent {
                                        __typename
                                        createdAt
                                        actor {
                                            login
                                        }
                                        requestedReviewer {
                                            ... on Team {
                                                name
                                            }
                                        }
                                    }

                                    ... on ReviewRequestRemovedEvent {
                                        __typename
                                        createdAt
                                        actor {
                                            login
                                        }
                                        requestedReviewer {
                                            ... on Team {
                                                name
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        authorAssociation
                        state
                        closed
                        closedAt
                        createdAt
                        updatedAt
                    }
                }
            }
        }
    }
    `;
}
