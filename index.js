require('dotenv').config()

const app = require('express')()
const axios = require('axios')
const crypto = require('crypto')
const { GraphQLClient, gql } = require('graphql-request')
const cors = require('cors')
const uuid = require('uuid').v4
const bodyParser = require('body-parser')
const querystring = require('querystring')
const { promiseSeries } = require('./utils')
const {
  USERNAME,
  PRIVATE_KEY,
  ORGANIZATION,
  CLIENT_ID,
  CLIENT_SECRET,
  TEMPLATE_REPO,
} = process.env

const client = new GraphQLClient('https://api.github.com/graphql', {
  headers: {
    Authorization: `bearer ${PRIVATE_KEY}`,
  },
})

const API_URL = 'https://api.github.com'
const auth = () => ({
  auth: {
    username: USERNAME,
    password: PRIVATE_KEY,
  },
})

app.use(cors())
app.use(bodyParser.json())

let cache = {}

const getAllUsersInOrganization = async () => {
  const response = await axios.get(
    `${API_URL}/orgs/${ORGANIZATION}/members`,
    auth()
  )
  return response.data
}

const getPullsForRepo = async (repo) => {
  const response = await axios.get(
    `${API_URL}/repos/${repo.full_name}/pulls?state=all`,
    auth()
  )
  return response.data
}

const getEventsForPage = async (page = 0, totalResults = []) => {
  if (page === 4) return totalResults
  try {
    const response = await axios.get(
      `${API_URL}/orgs/${ORGANIZATION}/events?per_page=100&page=${page}`,
      auth()
    )
    const result = [...totalResults, ...response.data]
    if (response.data.length === 100) {
      return getEventsForPage(page + 1, result)
    }
    return result
  } catch (e) {
    console.log(e)
  }
}

const getEvents = async () => getEventsForPage(0)

const getCreateRepoEvents = async () => {
  const events = await getEvents()
  return events.filter((event) => event.type === 'CreateEvent')
}

const getCommitsForRepo = async (repo) => {
  if (cache[repo.name]) return cache[repo.name]
  const response = await axios.get(
    `https://api.github.com/repos/${ORGANIZATION}/${repo.name}/commits`,
    auth()
  )
  cache[repo.name] = response.data
  return response.data
}

const getOwnerForRepo = async (repo) => {
  try {
    const commits = await getCommitsForRepo(repo)
    if (commits.length > 0) {
      if (commits[0].author) return commits[0].author
      return {
        ...commits[0].commit.author,
        login: commits[0].commit.author.name,
      }
    }
  } catch (e) {}
  return null
}

const getAllReposInOrganization = async () => {
  const response = await axios.get(
    `${API_URL}/orgs/${ORGANIZATION}/repos?per_page=100`,
    auth()
  )

  return Promise.all(
    response.data.map(async (repo) => {
      repo.owner = await getOwnerForRepo(repo)
      repo.pulls = await getPullsForRepo(repo)
      return repo
    })
  )
}

const requestReviewer = async ({ reviewer, pr }) => {
  const url = pr
    .replace('https://github.com', `${API_URL}/repos`)
    .replace('/pull', '/pulls')
  try {
    const response = await axios.post(
      `${url}/requested_reviewers`,
      {
        reviewers: [reviewer],
      },
      auth()
    )
    return response.status === 201
  } catch (e) {
    return false
  }
}

const getAccessToken = async ({ code, state }) => {
  const response = await axios.post(
    `https://github.com/login/oauth/access_token`,
    {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      state,
    }
  )
  const { access_token } = querystring.parse(response.data)
  return access_token
}

const createRepositoryForUser = async (canvasUsername) => {
  try {
    const response = await axios.post(
      `${API_URL}/repos/${TEMPLATE_REPO}/generate`,
      { name: canvasUsername, owner: ORGANIZATION },
      {
        ...auth(),
        headers: { Accept: 'application/vnd.github.baptiste-preview+json' },
      }
    )
    return response.data
  } catch (e) {}
}

const inviteUserToOrganization = async (userId) => {
  try {
    await axios.post(
      `${API_URL}/orgs/${ORGANIZATION}/invitations`,
      {
        invitee_id: userId,
      },
      auth()
    )
    return 'success'
  } catch (e) {
    if (e.response.status === 422) {
      return 'already-member'
    }
  }
  return 'error'
}

app.get('/', (_, res) => res.send('OK'))
app.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query
  const accessToken = await getAccessToken({ code, state })

  res.send(`<!DOCTYPE html>
  <html>
  <head>
    <script>
      window.opener && window.opener.postMessage(JSON.stringify({ success: true, accessToken: '${accessToken}' }), '*')
      window.close()
    </script>
  
    <body>
      <span style="padding: 2rem; font-size: 18px;">
        This page should close in a few seconds.
      </span> 
    </body>
  
  </html>`)
})
app.get('/oauth', (_, res) =>
  res.send({
    id: uuid(),
    clientId: CLIENT_ID,
  })
)
app.post('/invite', async (req, res) => {
  const { userId, canvasUsername } = req.body
  const invited = await inviteUserToOrganization(userId)
  let repository
  if (invited === 'success') {
    repository = await createRepositoryForUser(canvasUsername)
  }
  res.send({
    message: invited,
    repository: repository ? repository.html_url : null,
  })
})

app.get('/users', async (_, res) => {
  const users = await getAllUsersInOrganization()
  res.send(users)
})

app.get('/repos', async (_, res) => {
  if (cache['repos']) return res.send(cache['repos'])
  const repos = await getAllReposInOrganization()
  cache['repos'] = repos
  res.send(repos)
})
app.post('/request-reviewers', async (req, res) => {
  const reviews = req.body
  await promiseSeries(reviews, requestReviewer)
  const success = true
  res.send(success)
})
app.post('/request-reviewer', async (req, res) => {
  const { username, pullRequest } = req.body
  const success = await requestReviewer({
    reviewer: username,
    pr: pullRequest.url,
  })

  res.send(success)
})

app.get('/events/repo-created', async (_, res) => {
  const events = await getCreateRepoEvents()
  res.send(events)
})
app.get('/events', async (_, res) => res.send(await getEvents()))

app.get('/limit', async (_, res) => {
  const response = await axios.get(`${API_URL}/rate_limit`, auth())
  res.send(response.data)
})

app.get('/gql', async (req, res) => {
  const query = gql`
    {
      organization(login: "${ORGANIZATION}") {
        repositories(first: 100) {
          nodes {
            name
            url
            defaultBranchRef {
              target {
                ... on Commit {
                  history(first: 5) {
                    nodes {
                      author {
                        user {
                          login
                        }
                        name
                        email
                        date
                      }
                    }
                  }
                }
              }
            }
            pullRequests(first: 10) {
              nodes {
                url
                number
                state
                title
                author {
                  login
                }
                reviewRequests(first: 10) {
                  nodes {
                    requestedReviewer {
                      ... on User {
                        login
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `

  const getUserFromCommits = (ref) => {
    const blocklist = ['rrostt', 'hci-gu-bot']
    const commit = ref.target.history.nodes.find((commit) => {
      return (
        commit.author &&
        commit.author.user &&
        commit.author.user.login &&
        blocklist.indexOf(commit.author.user.login) === -1
      )
    })
    if (commit) {
      return commit.author.user.login
    }
  }

  const getUserFromPullRequests = (prs) => {
    const prWithAuthor = prs.find((pr) => pr.author && pr.author.login)

    if (prWithAuthor) {
      return prWithAuthor.author.login
    }
  }

  const data = await client.request(query, {})
  const mapped = data.organization.repositories.nodes.map((repo) => {
    let user
    if (repo.defaultBranchRef) {
      user = getUserFromCommits(repo.defaultBranchRef)
      if (!user) user = getUserFromPullRequests(repo.pullRequests.nodes)
      delete repo.defaultBranchRef
    }
    return {
      ...repo,
      user,
      pullRequests: repo.pullRequests.nodes.map((pr) => ({
        ...pr,
        reviewRequests: pr.reviewRequests.nodes.map((prReviewRequest) => ({
          ...prReviewRequest.requestedReviewer,
        })),
      })),
    }
  })
  res.send(mapped)
})

const dataForQuery = async (query, endCursor = null) => {
  const hash = crypto
    .createHash('sha1')
    .update(`${query}_${endCursor}`)
    .digest('base64')

  if (cache[hash]) {
    return cache[hash]
  }
  const response = await client.request(query, {
    endCursor,
  })
  cache[hash] = response

  return response
}

const getAllDataForQuery = async (query, endCursor, data = []) => {
  const response = await dataForQuery(query, endCursor)

  const commits = response.repository.ref.target.history.edges.map(
    (n) => n.node
  )
  const pageInfo = response.repository.ref.target.history.pageInfo
  if (pageInfo.hasNextPage) {
    return getAllDataForQuery(query, pageInfo.endCursor, [...data, ...commits])
  }
  return [...data, ...commits]
}

app.post('/gql-query', async (req, res) => {
  const query = gql([req.body.query])
  const data = await getAllDataForQuery(query)

  res.send(data)
})

app.get('/clear-cache', (_, res) => {
  cache = {}
  res.send('OK')
})

app.listen(4000)
