require('dotenv').config()

const app = require('express')()
const axios = require('axios')
const cors = require('cors')
const uuid = require('uuid').v4
const bodyParser = require('body-parser')
const querystring = require('querystring')
const {
  USERNAME,
  PRIVATE_KEY,
  ORGANIZATION,
  CLIENT_ID,
  CLIENT_SECRET,
} = process.env

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
    `${API_URL}/repos/${repo.full_name}/pulls`,
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
    `${API_URL}/orgs/${ORGANIZATION}/repos`,
    auth()
  )

  return Promise.all(
    response.data.map(async (repo) => {
      repo.owner = await getOwnerForRepo(repo)
      repo.pulls = repo.open_issues_count > 0 ? await getPullsForRepo(repo) : []
      return repo
    })
  )
}

const requestReviewer = async (username, pullRequest) => {
  try {
    const response = await axios.post(
      `${pullRequest.url}/requested_reviewers`,
      {
        reviewers: [username],
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
  const { userId } = req.body
  const invited = await inviteUserToOrganization(userId)
  res.send({
    message: invited,
  })
})

app.get('/users', async (_, res) => {
  const users = await getAllUsersInOrganization()
  res.send(users)
})
app.get('/repos', async (_, res) => {
  const repos = await getAllReposInOrganization()
  res.send(repos)
})
app.post('/request-reviewer', async (req, res) => {
  const { username, pullRequest } = req.body
  const success = await requestReviewer(username, pullRequest)

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

app.listen(4000)
