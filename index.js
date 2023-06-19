require("dotenv").config()
const express = require("express")
const app = express()
const port = process.env.PORT || 8000

var cors = require("cors")

const { Configuration, OpenAIApi } = require("openai")

const configuration = new Configuration({
  apiKey: process.env.AI_KEY,
})
const openai = new OpenAIApi(configuration)

app.listen(port, () => console.log(`Listening on port ${port}...`))

app.use(express.json())
app.use(cors())

const db = require("knex")({
  client: "pg",
  connection: {
    connectionString: process.env.DB_URL,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_DATABASE,
    extra: {
      ssl: false,
    },
  },
})

db.raw("SELECT 1")
  .then(() => {
    createTable()
    addMusicToDB()
    console.log("PostgreSQL connected.")
  })
  .catch((e) => {
    console.log("PostgreSQL not connected.")
    console.error(e)
  })

function generatePrompt(word) {
  return `
You are a multilingual dictionary. Provide strictly verified information only.
Convert this word "${word}" to initial form. Then, provide the following information of this converted word:

1) initial_form = Convert this word "${word}" to the initial form and the first letter must be capitalized.
2) forms = Provide all forms of this word and all forms must be capitalized.
3) synonyms = Provide three synonyms of this converted word.
4) pronunciation = Convert this word "${word}" to initial form. Then, provide phonetic transcription of this converted word.
5) usage_examples = (example = Provide three examples with this converted word) and (part_of_speech = Provide the part of speech of this converted word in each example). The following object must be {"example": example, "part_of_speech": part_of_speech}.
6) common_phrases = (phrase = Provide three common phrases with this converted word) and (meaning = The meaning of this phrase). The following object must be {"phrase": phrase, "meaning": meaning}.

If the word does not exist in the dictionary then reply only "null" else return only the following object in correct JSON format:
{
"initial_form": initial_form,
"forms": forms[],
"synonyms": synonyms[],
"pronunciation": pronunciation,
"usage_examples": usage_examples[],
"common_phrases": common_phrases[]
}`
}

async function addMusicToDB() {
  await db.schema.hasTable("tracks").then(async (exists) => {
    if (!exists) {
      await db.schema.createTable("tracks", (table) => {
        table.increments("id")
        table.string("duration")
        table.specificType("tags", "text ARRAY")
        table.string("createdAt")
        table.string("difficult")
        table.string("podcastName")
        table.string("image")
        table.string("title")
      })

      const data = require("./Track.json")
      data.forEach(async (track) => {
        try {
          await db("tracks").insert({
            duration: track.duration,
            tags: track.tags,
            createdAt: track.createdAt,
            difficult: track.difficult,
            podcastName: track.podcastName,
            image: track.image,
            title: track.title,
          })
        } catch (error) {
          console.log(error)
        }
      })
    }
  })
}

async function createTable() {
  await db.schema.hasTable("cards").then(async (exists) => {
    if (!exists) {
      await db.schema
        .createTable("cards", (table) => {
          table.increments("id")
          table.string("initial_form")
          table.specificType("forms", "text ARRAY")
          table.string("pronunciation")
          table.specificType("synonyms", "text ARRAY")
          table.specificType("usage_examples", "integer ARRAY")
          table.specificType("common_phrases", "integer ARRAY")
        })
        .createTable("forms", (table) => {
          table.string("initial_form")
          table.string("form_name")
        })
        .createTable("usage_examples", (table) => {
          table.increments("usage_example_id")
          table.string("example")
          table.string("part_of_speech")
        })
        .createTable("common_phrases", (table) => {
          table.increments("common_phrase_id")
          table.string("phrase")
          table.string("meaning")
        })
    }
  })
}

async function getCard(word) {
  try {
    const initial_form = await db("forms")
      .andWhere("form_name", "=", word)
      .orWhere("initial_form", "=", word)

    if (!initial_form) return

    const card = await db("cards").where(
      "initial_form",
      "=",
      initial_form[0]?.initial_form
    )

    const usage_examples = await db("usage_examples").whereIn(
      "usage_example_id",
      card[0]?.usage_examples
    )

    const common_phrases = await db("common_phrases").whereIn(
      "common_phrase_id",
      card[0]?.usage_examples
    )

    const result = {
      ...card[0],
      usage_examples: usage_examples,
      common_phrases: common_phrases,
    }
    return result
  } catch (err) {
    console.log("ERROR", err)
  }
}

async function getWord(word) {
  try {
    const res = await openai.createCompletion({
      model: "text-davinci-003",
      prompt: generatePrompt(word),
      temperature: 1,
      max_tokens: 2048,
    })
    console.log("AI RESPONSE:", res.data.choices[0].text)
    const data = JSON.parse(res.data.choices[0].text)
    return data
  } catch (err) {
    console.log(err)
    return null
  }
}

async function createCard(data) {
  try {
    await db("forms")
      .returning("*")
      .insert(
        data.forms.map((form_name) => ({
          initial_form: data.initial_form,
          form_name: form_name,
        }))
      )
    const usage_examples = await db("usage_examples")
      .returning("usage_example_id")
      .insert(data.usage_examples)

    const common_phrases = await db("common_phrases")
      .returning("common_phrase_id")
      .insert(data.common_phrases)

    const card = await db("cards")
      .returning("*")
      .insert({
        initial_form: data.initial_form,
        forms: data.forms,
        pronunciation: `[${data.pronunciation}]`,
        synonyms: data.synonyms,
        usage_examples: usage_examples.map((a) => a.usage_example_id),
        common_phrases: common_phrases.map((a) => a.common_phrase_id),
      })
    return data
  } catch (err) {
    console.log(err)
  }
}

app.post("/api/cards/create", async (req, res) => {
  const { new_word } = req.body

  await createTable()

  const card = await getCard(new_word)

  if (card) return res.status(200).send(card)

  const word = await getWord(new_word)

  if (!word) return res.status(404).send("The word does not exist!")

  const newCard = await createCard(word)

  return res.status(200).send(newCard)
})

app.get("/api/cards/getAll", async (req, res) => {
  try {
    const card = await db("cards").select("initial_form")

    return res.send(card)
  } catch (err) {
    console.log("ERROR", err)
  }
})

app.get("/api/tracks/getAll", async (req, res) => {
  await addMusicToDB()
  const { page, page_count } = req.query
  try {
    const count = await db("tracks").count()
    const tracks = await db("tracks")
      .select("*")
      .offset(page * page_count)
      .limit(page_count)
    return res.send({ data: tracks, count: count[0].count })
  } catch (err) {
    console.log("ERROR", err)
  }
})

app.get("/", async (req, res) => {
  res.send("SUCCESS")
})
