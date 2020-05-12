const compareVersions = require('compare-versions')

const { getVersionInfo } = require('./versions')
const { template } = require('./template')
const log = require('./log')

const UNCATEGORIZED = 'UNCATEGORIZED'

const sortReleases = releases => {
  // For semver, we find the greatest release number
  // For non-semver, we use the most recently merged
  try {
    return releases.sort((r1, r2) => compareVersions(r1.tag_name, r2.tag_name))
  } catch (error) {
    return releases.sort(
      (r1, r2) => new Date(r1.published_at) - new Date(r2.published_at)
    )
  }
}

module.exports.findReleases = async ({ app, context }) => {
  let releases = await context.github.paginate(
    context.github.repos.listReleases.endpoint.merge(
      context.repo({
        per_page: 100
      })
    )
  )

  log({ app, context, message: `Found ${releases.length} releases` })

  const sortedPublishedReleases = sortReleases(releases.filter(r => !r.draft))
  const draftRelease = releases.find(r => r.draft)
  const lastRelease =
    sortedPublishedReleases[sortedPublishedReleases.length - 1]

  if (draftRelease) {
    log({ app, context, message: `Draft release: ${draftRelease.tag_name}` })
  } else {
    log({ app, context, message: `No draft release found` })
  }

  if (lastRelease) {
    log({ app, context, message: `Last release: ${lastRelease.tag_name}` })
  } else {
    log({ app, context, message: `No last release found` })
  }

  return { draftRelease, lastRelease }
}

const contributorsSentence = ({ commits, pullRequests }) => {
  const contributors = new Set()

  commits.forEach(commit => {
    if (commit.author.user) {
      contributors.add(`@${commit.author.user.login}`)
    } else {
      contributors.add(commit.author.name)
    }
  })

  pullRequests.forEach(pullRequest => {
    if (pullRequest.author) {
      contributors.add(`@${pullRequest.author.login}`)
    }
  })

  const sortedContributors = Array.from(contributors).sort()
  if (sortedContributors.length > 1) {
    return (
      sortedContributors.slice(0, sortedContributors.length - 1).join(', ') +
      ' and ' +
      sortedContributors.slice(-1)
    )
  } else {
    return sortedContributors[0]
  }
}

const getIncludedPullRequests = (pullRequests, config) => {
  return pullRequests.filter(pullRequest => {
    const labels = pullRequest.labels.nodes

    return !labels.some(label => config['exclude-labels'].includes(label.name))
  })
}

const categorizePullRequests = (pullRequests, config) => {
  const allCategoryLabels = config.categories.flatMap(
    category => category.labels
  )
  const uncategorizedPullRequests = []
  const categorizedPullRequests = [...config.categories].map(category => {
    return { ...category, pullRequests: [] }
  })

  const filterUncategorizedPullRequests = pullRequest => {
    const labels = pullRequest.labels.nodes

    if (
      labels.length === 0 ||
      !labels.some(label => allCategoryLabels.includes(label.name))
    ) {
      uncategorizedPullRequests.push(pullRequest)
      return false
    }
    return true
  }

  // we only want pull requests that have yet to be categorized
  const filteredPullRequests = getIncludedPullRequests(
    pullRequests,
    config
  ).filter(filterUncategorizedPullRequests)

  categorizedPullRequests.map(category => {
    filteredPullRequests.map(pullRequest => {
      // lets categorize some pull request based on labels
      // note that having the same label in multiple categories
      // then it is intended to "duplicate" the pull request into each category
      const labels = pullRequest.labels.nodes
      if (labels.some(label => category.labels.includes(label.name))) {
        category.pullRequests.push(pullRequest)
      }
    })
  })

  return [uncategorizedPullRequests, categorizedPullRequests]
}

const resolveIncrement = (pullRequests, config) => {
  const fallback = 'PATCH'

  if (!config.increment) {
    return fallback
  }

  pullRequests = getIncludedPullRequests(pullRequests, config)

  const usedLabels = pullRequests.flatMap(pullRequest =>
    pullRequest.labels.nodes.map(label => label.name)
  )

  if (!usedLabels.length) {
    return fallback
  }

  const areIncrementLabelsUsed = incrementLabels =>
    incrementLabels.some(label => usedLabels.includes(label))

  if (areIncrementLabelsUsed(config.increment['major-labels'])) {
    return 'MAJOR'
  }

  if (areIncrementLabelsUsed(config.increment['minor-labels'])) {
    return 'MINOR'
  }

  return fallback
}

const generateChangeLog = (mergedPullRequests, config) => {
  if (mergedPullRequests.length === 0) {
    return config['no-changes-template']
  }

  const [
    uncategorizedPullRequests,
    categorizedPullRequests
  ] = categorizePullRequests(mergedPullRequests, config)

  const pullRequestToString = pullRequests =>
    pullRequests
      .map(pullRequest =>
        template(config['change-template'], {
          $TITLE: pullRequest.title,
          $NUMBER: pullRequest.number,
          $AUTHOR: pullRequest.author ? pullRequest.author.login : 'ghost'
        })
      )
      .join('\n')

  const changeLog = []

  if (uncategorizedPullRequests.length) {
    changeLog.push(pullRequestToString(uncategorizedPullRequests))
    changeLog.push('\n\n')
  }

  categorizedPullRequests.map((category, index) => {
    if (category.pullRequests.length) {
      changeLog.push(`## ${category.title}\n\n`)

      changeLog.push(pullRequestToString(category.pullRequests))

      if (index + 1 !== categorizedPullRequests.length) changeLog.push('\n\n')
    }
  })

  return changeLog.join('').trim()
}

module.exports.generateReleaseInfo = ({
  commits,
  config,
  lastRelease,
  mergedPullRequests,
  version = undefined,
  tag = undefined,
  name = undefined
}) => {
  let body = config.template

  body = template(
    body,
    {
      $PREVIOUS_TAG: lastRelease ? lastRelease.tag_name : '',
      $CHANGES: generateChangeLog(mergedPullRequests, config),
      $CONTRIBUTORS: contributorsSentence({
        commits,
        pullRequests: mergedPullRequests
      })
    },
    config.replacers
  )

  // identify an input version, from the most accurate override parameter to
  // the least
  const inputVersion = version || tag || name

  // resolve the increment, unless an input version has been specified
  const increment = inputVersion
    ? null
    : resolveIncrement(mergedPullRequests, config)

  const versionInfo = getVersionInfo(
    lastRelease,
    config['version-template'],
    inputVersion,
    increment
  )

  if (versionInfo) {
    body = template(body, versionInfo)
  }

  if (tag === undefined) {
    tag = versionInfo ? template(config['tag-template'] || '', versionInfo) : ''
  }

  if (name === undefined) {
    name = versionInfo
      ? template(config['name-template'] || '', versionInfo)
      : ''
  }

  return {
    name,
    tag,
    body
  }
}

module.exports.createRelease = ({
  context,
  releaseInfo,
  shouldDraft,
  config
}) => {
  return context.github.repos.createRelease(
    context.repo({
      name: releaseInfo.name,
      tag_name: releaseInfo.tag,
      body: releaseInfo.body,
      draft: shouldDraft,
      prerelease: config.prerelease
    })
  )
}

module.exports.updateRelease = ({
  context,
  draftRelease,
  releaseInfo,
  shouldDraft,
  config
}) => {
  const updateReleaseParams = updateDraftReleaseParams({
    name: releaseInfo.name || draftRelease.name,
    tag_name: releaseInfo.tag || draftRelease.tag_name
  })

  return context.github.repos.updateRelease(
    context.repo({
      release_id: draftRelease.id,
      body: releaseInfo.body,
      draft: shouldDraft,
      ...updateReleaseParams
    })
  )
}

function updateDraftReleaseParams(params) {
  const updateReleaseParams = { ...params }

  // Let GitHub figure out `name` and `tag_name` if undefined
  if (!updateReleaseParams.name) {
    delete updateReleaseParams.name
  }
  if (!updateReleaseParams.tag_name) {
    delete updateReleaseParams.tag_name
  }

  return updateReleaseParams
}
