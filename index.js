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

const getAllReposInOrganization = async () => {
  const response = await axios.get(
    `${API_URL}/orgs/${ORGANIZATION}/repos`,
    auth()
  )

  return Promise.all(
    response.data.map(async (repo) => {
      const pulls = await getPullsForRepo(repo)
      repo.pulls = pulls
      return repo
    })
  )
}

const requestReviewer = async (user, pullRequest) => {
  const path = pullRequest.url.replace('https://api.github.com/', '')
  try {
    const response = await axios.post(
      `${API_URL}/${path}/requested_reviewers`,
      {
        reviewers: [user.login],
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
  const { user, pullRequest } = req.body
  const success = await requestReviewer(user, pullRequest)

  res.send(success)
})

app.listen(4000)
