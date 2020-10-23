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

app.use(cors())
app.use(bodyParser.json())

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
  const response = await axios.post(
    `https://api.github.com/orgs/${ORGANIZATION}/invitations`,
    {
      invitee_id: userId,
    },
    {
      auth: {
        username: USERNAME,
        password: PRIVATE_KEY,
      },
    }
  )
  return !!response.data.id
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
    success: invited,
  })
})

app.listen(4000)
