import "dotenv/config";

import { Context, Telegraf, Markup } from "telegraf";
import type { Update } from "telegraf/types";
import { callbackQuery, message } from "telegraf/filters";
import postgres from "postgres";
import { ZodError, z } from "zod";
import cron from "node-cron";
// TODO: unpacking postgres with the current build results in export not provided
// for now resolved with using postgres.PostgreError
// related: https://github.com/porsager/postgres/issues/684
// import { PostgresError } from "postgres";

import db from "./src/db/db.js";
import { log_events, logs, users } from "./src/db/schema.js";
import { and, sql, eq, between, desc } from "drizzle-orm";

// types
type Guild = "SIK" | "KIK";

enum Sport {
  steps = "Steps",
  biking = "Biking",
  running_walking = "Running/Walking",
}

interface SportStatReturn {
  guild: Guild;
  distance: number;
  entries: number;
  sport: Sport;
}

// connect to db
const sql_pg = postgres(
  process.env.POSTGRES_URL ||
    "postgresql://username:password@springbattlebot-db:5432/database"
);

// database access functions

async function changeGuild(userId: number, guild: Guild) {
  await db.update(users).set({ guild: guild }).where(eq(users.id, userId));
  await db.update(logs).set({ guild: guild }).where(eq(logs.userId, userId));
}

async function updateName(userId: number, name: string) {
  await db.update(users).set({ userName:  name}).where(eq(users.id, userId));
}

async function getStats() {
  const stats = await db
    .select({
      guild: logs.guild,
      sport: logs.sport,
      sum: sql`sum(${logs.distance})`.mapWith(Number),
    })
    .from(logs)
    .groupBy(logs.guild, logs.sport);

  return Object.values(Sport).flatMap((sport) => {
    const kik = stats.find((s) => s.sport === sport && s.guild === "KIK") || {
      guild: "KIK",
      sport,
      sum: 0,
    };

    const sik = stats.find((s) => s.sport === sport && s.guild === "SIK") || {
      guild: "SIK",
      sport,
      sum: 0,
    };

    return { sport, sik_sum: sik.sum, kik_sum: kik.sum };
  });
}

async function getStatsByDate(start_date: Date, limit_date: Date) {
  const stats = await db
    .select({
      guild: logs.guild,
      sport: logs.sport,
      sum: sql`sum(${logs.distance})`.mapWith(Number),
    })
    .from(logs)
    .where(between(logs.createdAt, start_date, limit_date))
    .groupBy(logs.guild, logs.sport);

  return Object.values(Sport).flatMap((sport) => {
    const kik = stats.find((s) => s.sport === sport && s.guild === "KIK") || {
      guild: "KIK",
      sport,
      sum: 0,
    };

    const sik = stats.find((s) => s.sport === sport && s.guild === "SIK") || {
      guild: "SIK",
      sport,
      sum: 0,
    };

    return { sport, sik_sum: sik.sum, kik_sum: kik.sum };
  });
}

async function getUser(user_id: number) {
  const user =
    await sql_pg`SELECT user_name, guild FROM users WHERE id = ${user_id}`;

  return user;
}

async function getGuildUsers(guild: string) {
  const users =
    await sql_pg`SELECT id, user_name FROM users WHERE guild = ${guild}`;

  return users;
}

async function getDistanceBySport() {
  return await sql_pg<SportStatReturn[]>`
      SELECT guild, sport, SUM(distance) AS distance, COUNT(distance)::int AS entries
        FROM logs 
        GROUP BY guild, sport
      `;
}

async function getMyStats(user_id: number) {
  const stats = await db
    .select({
      sport: logs.sport,
      sum: sql`sum(${logs.distance})`.mapWith(Number),
    })
    .from(logs)
    .where(eq(logs.userId, user_id))
    .groupBy(logs.sport);

  return Object.values(Sport).map((sport) => {
    const sik = stats.find((s) => s.sport === sport) || {
      sport,
      sum: 0,
    };

    return { sport, sum: sik.sum.toFixed(1) };
  });
}

async function getMyDaily(user_id: number, ) {
  const today = new Date(new Date().setHours(new Date().getHours() + 3));

  const start_date = new Date(
    new Date(new Date().setDate(today.getDate())).toDateString()
  );
  const limit_date = new Date(
    new Date(
      new Date().setDate(today.getDate() + 1)
    ).toDateString()
  );

  const stats = await db
    .select({
      sport: logs.sport,
      sum: sql`sum(${logs.distance})`.mapWith(Number),
    })
    .from(logs)
    .where(
      and(
        eq(logs.userId, user_id),
        between(logs.createdAt, start_date, limit_date)
      )
    )
    .groupBy(logs.sport);

  return Object.values(Sport).map((sport) => {
    const sik = stats.find((s) => s.sport === sport) || {
      sport,
      sum: 0,
    };

    return { sport, sum: sik.sum.toFixed(1) };
  });
}

async function getTop(
  guild: Guild,
  limit: number,
  start_date?: Date,
  limit_date?: Date
) {
  const topX = await db
    .select({
      userName: users.userName,
      totalDistance: sql<number>`sum(${logs.distance})`,
    })
    .from(logs)
    .fullJoin(users, eq(logs.userId, users.id))
    .where(
      !start_date || !limit_date
        ? eq(logs.guild, guild)
        : and(
            eq(logs.guild, guild),
            between(logs.createdAt, start_date, limit_date)
          )
    )
    .groupBy(users.userName, users.id)
    .orderBy(desc(sql<number>`sum(${logs.distance})`)) // TODO: can I get this from the select somehow?
    .limit(limit);

  return topX;
}

async function insertLog(user_id: number, sport: Sport, distance: number) {
  if (user_id !== null && sport !== null && distance !== null) {
    const [user] = await db.select().from(users).where(eq(users.id, user_id));

    if (!user.guild) {
      return;
    }

    await db.insert(logs).values({
      userId: user_id,
      guild: user.guild,
      sport: sport,
      distance: distance,
    });
  }
}

async function getLogEvent(user_id: number) {
  const [log_event] = await db
    .select()
    .from(log_events)
    .where(eq(log_events.user_id, user_id));

  return log_event;
}

async function upsertLogEvent(user_id: number) {
  return await sql_pg`
    INSERT INTO log_events 
      (user_id) VALUES (${user_id})
    ON CONFLICT (user_id) DO UPDATE
      SET sport = NULL;
  `;
}

async function setLogEventSport(user_id: number, sport: Sport) {
  return await db
    .update(log_events)
    .set({ sport })
    .where(eq(log_events.user_id, user_id))
    .returning();
}

async function deleteLogEvent(user_id: number) {
  return await sql_pg`DELETE FROM log_events WHERE user_id = ${user_id}`;
}

async function insertUser(user_id: number, user_name: string, guild?: Guild) {
  return await sql_pg`
    INSERT INTO users
      (id, user_name, guild)
    VALUES
      (${user_id}, ${user_name}, ${guild || null})
    ON CONFLICT DO NOTHING;
  `;
}

async function setUserGuild(user_id: number, guild: Guild) {
  await sql_pg`UPDATE users SET guild = ${guild} WHERE id = ${user_id};`;
}

// bot logic

async function askSport(ctx: Context) {
  ctx.reply(
    "Please choose the sport:",
    Markup.inlineKeyboard([
      Markup.button.callback(
        Sport.running_walking,
        `sport ${Sport.running_walking}`
      ),
      Markup.button.callback(Sport.steps, `sport ${Sport.steps}`),
      Markup.button.callback(Sport.biking, `sport ${Sport.biking}`),
    ])
  );
}

async function getDailyMessage(day_modifier: number = 0) {
  const dailyTopLength = 5;
  const today = new Date(new Date().setHours(new Date().getHours() + 3));

  const start_date = new Date(
    new Date(new Date().setDate(today.getDate() + day_modifier)).toDateString()
  );
  const limit_date = new Date(
    new Date(
      new Date().setDate(today.getDate() + day_modifier + 1)
    ).toDateString()
  );

  start_date.setHours(start_date.getHours() + 3);

  let message = `Daily stats for ${start_date.toLocaleDateString("FI")}\n\n`;

  const dailyStats = await getStatsByDate(start_date, limit_date);

  let kik_stats = "KIK:\n";
  let sik_stats = "SIK:\n";

  dailyStats.forEach((s) => {
    kik_stats += ` - ${s.sport}: ${s.kik_sum.toFixed(1)} km\n`;
    sik_stats += ` - ${s.sport}: ${s.sik_sum.toFixed(1)} km\n`;
  });

  message += kik_stats + "\n" + sik_stats;

  // Get daily top and format

  const kikDailyTop = await getTop(
    "KIK",
    dailyTopLength,
    start_date,
    limit_date
  );

  const sikDailyTop = await getTop(
    "SIK",
    dailyTopLength,
    start_date,
    limit_date
  );

  message += `\nKIK top ${dailyTopLength}\n`;

  for (const [index, user] of kikDailyTop.entries()) {
    message += `  ${index + 1}. ${user.userName}: ${user.totalDistance.toFixed(
      1
    )} km\n`;
  }

  message += `\nSIK top ${dailyTopLength}\n`;

  for (const [index, user] of sikDailyTop.entries()) {
    message += `  ${index + 1}. ${user.userName}: ${user.totalDistance.toFixed(
      1
    )} km\n`;
  }

  // Get all-time top and format

  const kikTop = await getTop("KIK", 3)

  const sikTop = await getTop("SIK", 3)

  message += `\nKIK all-time top 3\n`;

  for (const [index, user] of kikTop.entries()) {
    message += `  ${index + 1}. ${user.userName}: ${user.totalDistance.toFixed(
      1
    )} km\n`;
  }

  message += `\nSIK all-time top 3\n`;

  for (const [index, user] of sikTop.entries()) {
    message += `  ${index + 1}. ${user.userName}: ${user.totalDistance.toFixed(
      1
    )} km\n`;
  }

  return message;
}

async function handleDaily(ctx: Context, day_modifier: number = 0) {
  const message = await getDailyMessage(day_modifier);

  ctx.reply(message);
}

async function handleAll(ctx: Context) {
  const sports = await getDistanceBySport();

  const sik_users = await getGuildUsers("SIK");
  const kik_users = await getGuildUsers("KIK");

  // TODO: rename messages to text or replyText due to telegraf message filter method
  let message = `SIK participants: ${sik_users.length}\nKIK participants: ${kik_users.length}\n\n`;

  ["SIK", "KIK"].forEach((guild) =>
    Object.values(Sport).map((sport) => {
      const asd = sports.find((r) => r.sport === sport && r.guild === guild);

      message += `${guild} ${sport}: ${
        asd ? asd.distance.toFixed(1) : 0
      }km and ${asd ? asd.entries : 0} entries\n`;

      // TODO: janky conditional formatting
      if (sport === Sport.running_walking) {
        message += "\n";
      }
    })
  );

  const kik_personals = await getTop("KIK", 5);
  const sik_personals = await getTop("SIK", 5);

  kik_personals.forEach(
    (p, i) => (message += `${i + 1}. ${p.userName}: ${p.totalDistance} km\n`)
  );

  message += "\n";

  sik_personals.forEach(
    (p, i) => (message += `${i + 1}. ${p.userName}: ${p.totalDistance} km\n`)
  );

  ctx.reply(message);
}

if (process.env.BOT_TOKEN && process.env.ADMINS) {
  const admins = JSON.parse(process.env.ADMINS);
  const bot = new Telegraf(process.env.BOT_TOKEN);

  // start
  bot.start(async (ctx: Context) => {
    if (ctx.message && ctx.message.chat.type == "private") {
      const user_id = Number(ctx.message.from.id);
      const user = await getUser(user_id);

      const message_base =
        "Hello there, welcome to the KIK-SIK Spring Battle!\n\nTo record kilometers for your guild send me a picture of your achievement, this can be for example a screenshot of your daily steps or a Strava log showing the exercise amount and route. After this I'll ask a few questions recarding the exercise.\n\nYou can also give the photo a caption in the format \"SPORT, DISTANCE\", and I will try to get the information from that. For Running/Walking either one is sufficient, and for Biking \"Cycling\" is also accepted. Just the first letter is also accepted. Letter case does not matter.\nFor example: \"running, 5.5\"\n\n You can check how many kilometers you have contributed with /personal. Additionally you can check the current status of the battle with /status. \n\nIf you have any questions about the battle you can ask in the main group and the organizers will answer you! If some technical problems appear with me, you can contact @JustusOjala.";

      if (user[0] && user[0].guild) {
        ctx.reply(
          message_base + `\n\nYou are competing with ${user[0].guild}.`
        );
      } else {
        const user_name = ctx.message.from.last_name
          ? `${ctx.message.from.first_name} ${ctx.message.from.last_name}`
          : ctx.message.from.first_name;

        await insertUser(user_id, user_name);

        ctx.reply(
          message_base +
            "\n\nTo register Choose guild you are going to represent, after this just send me a picture to log your kilometers!",
          Markup.inlineKeyboard([
            Markup.button.callback("SIK", "guild SIK"),
            Markup.button.callback("KIK", "guild KIK"),
          ])
        );
      }
    }
  });

  // admin commands
  bot.command("daily", async (ctx: Context) => {
    // TODO: add ability to choose the day range
    if (ctx.message && admins.list.includes(ctx.message.from.id)) {
      ctx.reply(
        "Please choose the day:",
        Markup.inlineKeyboard([
          Markup.button.callback("Today", "daily 0"),
          Markup.button.callback("Yesterday", "daily -1"),
        ])
      );
    }else if(ctx.message){
      ctx.reply(`I'm sorry, ${ctx.message.from.first_name}. I'm afraid I can't do that.`)
    }
  });

  bot.command("all", async (ctx: Context) => {
    if (ctx.message && admins.list.includes(ctx.message.from.id)) {
      await handleAll(ctx);
    }else if(ctx.message){
      ctx.reply(`I'm sorry, ${ctx.message.from.first_name}. I'm afraid I can't do that.`)
    }
  });

  // group commands
  bot.command("status", async (ctx: Context) => {
    if(ctx.message && ctx.message.chat.type == "private"){
      const stats = await getStats();

      let sik_wins = 0;
      let kik_wins = 0;

      let message = "";

      let kik_stats = "KIK:\n";
      let sik_stats = "SIK:\n";

      stats.forEach((s) => {
        if (s.kik_sum > s.sik_sum) {
          kik_wins += 1;
        } else if (s.kik_sum < s.sik_sum) {
          sik_wins += 1;
        }

        kik_stats += ` - ${s.sport}: ${s.kik_sum.toFixed(1)} km${
          s.kik_sum > s.sik_sum ? " 🏆" : ` (-${(s.sik_sum - s.kik_sum).toFixed(1)} km)`
        }\n`;
        sik_stats += ` - ${s.sport}: ${s.sik_sum.toFixed(1)} km${
          s.sik_sum > s.kik_sum ? " 🏆" : ` (-${(s.kik_sum - s.sik_sum).toFixed(1)} km)`
        }\n`;
      });

      if (kik_wins < sik_wins) {
        message += `JAPPADAIDA! Sik has the lead by winning ${sik_wins} categories.\n\n`;
      } else if (kik_wins > sik_wins) {
        message = `Yy-Kaa-Kone! Kik has the lead by winning ${kik_wins} categories.\n\n`;
      } else {
        message += `It seems to be even with ${sik_wins} category wins for both guilds.\n\n`;
      }

      ctx.reply(message + kik_stats + "\n" + sik_stats);
    }else{
      ctx.reply("I'm sorry, \"status\" only works in private now")
    }
  });

  // personal commands
  bot.command("personal", async (ctx: Context) => {
    if (ctx.message && ctx.message.chat.type == "private") {
      const user_id = Number(ctx.message.from.id);

      const my_stats = await getMyStats(user_id);

      let message = "Your personal stats are:\n\n";

      my_stats.forEach((s) => (message += `${s.sport}: ${s.sum}km\n`));

      ctx.reply(message);
    }
  });

  bot.command("reset_guild", (ctx: Context) => {
    if (ctx.message && ctx.message.chat.type === "private") {
      ctx.reply(
        "Choose guild",
        Markup.inlineKeyboard([
          Markup.button.callback("SIK", "reset_guild SIK"),
          Markup.button.callback("KIK", "reset_guild KIK"),
        ])
      );
    }
  });

  bot.command("update_name", (ctx: Context) => {
    if (ctx.message && ctx.message.chat.type === "private") {
      const user_id = Number(ctx.message.from.id);
      const user_name = ctx.message.from.last_name
          ? `${ctx.message.from.first_name} ${ctx.message.from.last_name}`
          : ctx.message.from.first_name;
      if(user_id && user_name){
        updateName(user_id, user_name)
          .then(() => ctx.reply(`Your name was successfully updated to ${user_name}.`))
          .catch(() => ctx.reply("Something went wrong while updating your name."))
      }else{
        ctx.reply("Your id or name could not be determined.")
      }
    }
  });

  bot.command("mydaily", async (ctx: Context) => {
    if (ctx.message && ctx.message.chat.type == "private") {
      const user_id = Number(ctx.message.from.id);

      const my_stats = await getMyDaily(user_id);

      let message = "Your personal stats for today are:\n\n";

      my_stats.forEach((s) => (message += `${s.sport}: ${s.sum}km\n`));

      ctx.reply(message);
    }
  });

  bot.command("cancel", (ctx: Context) => {
    if (ctx.has(message("text"))) {
      const user_id = Number(ctx.message.from.id);

      deleteLogEvent(user_id);

      ctx.reply("Succesfully stopped the logging event.");
    }
  });

  // text handler
  bot.on(message("text"), async (ctx: Context) => {
    // check the data for active log and
    if (ctx.has(message("text"))) {
      const user_id = Number(ctx.message.from.id);

      const log_event = await getLogEvent(user_id);

      if (log_event && log_event.sport !== null) {
        try {
          const text = ctx.message.text;

          const distance = z.number().min(1).parse(Number(text));

          if(log_event.sport !== Sport.steps && distance > 1000){
            ctx.reply(
              "You inserted a distance exceeding 1000 km. Are you sure you did not intend to record steps?",
              Markup.inlineKeyboard([
                Markup.button.callback(
                  `Record as ${log_event.sport}`,
                  `sportFix ${log_event.sport} ${distance}`
                ),
                Markup.button.callback(`Record as ${Sport.steps}`, `sportFix ${Sport.steps} ${distance}`),
              ])
            );
          }else{
            await insertLog(
              log_event.user_id,
              log_event.sport as Sport,
              log_event.sport === Sport.steps ? distance * 0.0007 : distance
            );

            ctx.reply(`Recorded ${log_event.sport} with ${distance} ${log_event.sport === Sport.steps ? "steps" : "km"}`);
          }

          await deleteLogEvent(log_event.user_id);

          ctx.reply("Thanks for participating!");
        } catch (e) {
          if (e instanceof postgres.PostgresError) {
            console.log(e);
            ctx.reply(
              "Encountered an error with logging data please contact @JustusOjala"
            );
          }

          if (e instanceof ZodError) {
            ctx.reply(
              log_event.sport === Sport.steps
                ? "Something went wrong with your input. Make sure you use whole numbers for steps. Please try again."
                : "Something went wrong with your input. Make sure you use . as separator for kilometers and meters, also the minimum distance is 1km. Please try again."
            );
          }
        }
      }
    }
  });

  bot.on(message("photo"), async (ctx: Context) => {
    if (ctx.message && ctx.message.chat.type === "private") {
      if(process.env.ACCEPTING_SUBMISSIONS !== "true"){
        ctx.reply("Sorry, I am not currently accepting submissions.")
        return;
      }
      const user_id = Number(ctx.message.from.id);
      const user = await getUser(user_id);

      if (user[0] && user[0].guild) {
        await upsertLogEvent(user_id);

        // TODO: upload photo somwhere and set reference,
        // alternatively can we fetch photos from some chat?
        
        if(ctx.has(message("photo")) && ctx.message.caption){ 
          const parts = ctx.message.caption.split(',').map((x) => x.trim().toLowerCase())
        
          if(parts.length == 2 && Number(parts[1])){
            const distance = z.number().min(1).parse(Number(parts[1]));

            switch(parts[0]){
              case "walking":
              case "running":
              case "running/walking":
              case "r":
              case "w":
                if(distance > 1000){
                  await ctx.reply("I parsed that as Running/Walking with more than 1000 km. That's probably wrong.");
                  askSport(ctx);
                }else{
                  await insertLog(
                    user_id,
                    Sport.running_walking,
                    distance
                  );
      
                  ctx.reply(`Recorded Running/Walking with ${distance} km`);
                  await deleteLogEvent(user_id);
                  ctx.reply("Thanks for participating!");
                }
                break;
              case "biking":
              case "cycling":
              case "b":
              case "c":
                if(distance > 1000){
                  await ctx.reply("I parsed that as Biking with more than 1000 km. That's probably wrong.");
                  askSport(ctx);
                }else{
                  await insertLog(
                    user_id,
                    Sport.biking,
                    distance
                  );
      
                  ctx.reply(`Recorded Biking with ${distance} km`);
                  await deleteLogEvent(user_id);
                  ctx.reply("Thanks for participating!");
                }
                break;
              case "activity":
              case "steps":
              case "a":
              case "s":
                await insertLog(
                  user_id,
                  Sport.steps,
                  distance * 0.0007
                );
    
                ctx.reply(`Recorded Steps with ${distance} steps`);
                await deleteLogEvent(user_id);
                ctx.reply("Thanks for participating!");
                break;
              default:
                await ctx.reply("Seems you tried to include sport information with the photo, but I could not parse it. Sorry.");
                askSport(ctx);
                break;
            }
          }else{
            askSport(ctx);
          }
        }else{
          askSport(ctx);
        }
      } else {
        console.log(`User id: ${user_id}. User: ${user}`);
        ctx.reply("Please register with /start before recording kilometers.");
      }
    }
  });

  // callback handler
  bot.on("callback_query", async (ctx: Context<Update>) => {
    // answer callback
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined);

    if (ctx.has(callbackQuery("data"))) {
      const user_id = Number(ctx.callbackQuery.from.id);

      var dataSplit = ctx.callbackQuery.data.split(" ");

      var logType = dataSplit[0];
      var logData = dataSplit[1];

      // stop logging if no active log found when user
      // uses /cancel and then answers the inlineKeyboard
      switch (logType) {
        case "guild":
          const user = await getUser(user_id);

          if (!user) {
            // Shouldnt be possible but we can just create user here also
            // TODO: should return to set start?
          }

          await setUserGuild(user_id, logData as Guild);

          ctx.reply(
            `Thanks! You chose ${logData} as your guild.\n\nTo start logging kilometers just send me a picture of your accomplishment!`
          );
          break;
        case "reset_guild":
          await changeGuild(user_id, logData as Guild);

          ctx.reply(`Your guild is now set to ${logData}.`);
          break;
        case "sport":
          const log_event = await setLogEventSport(user_id, logData as Sport);

          if (log_event.length === 0) {
            ctx.reply("Something went wrong please try again.");
            break;
          }

          ctx.reply(
            logData === Sport.steps
              ? "Type the number of steps that you have walked. These are converted to kilometers automatically"
              : "Type the number of kilometers using '.' as a separator, for example: 5.5"
          );
          break;
        case "sportFix":
          const distance = z.number().min(1).parse(Number(dataSplit[2]));
          const sport = logData as Sport;
  
          await insertLog(
            user_id,
            sport,
            sport === Sport.steps ? distance * 0.0007 : distance
          );

          ctx.reply(`Recorded ${sport} with ${distance} ${sport === Sport.steps ? "steps" : "km"}`);
          break;
        case "daily":
          await handleDaily(ctx, Number(logData));
          break;
      }
    }
  });

  console.log("Starting bot");

  if (process.env.NODE_ENV === "production" && process.env.DOMAIN) {
    console.log("Running webhook");

    bot.launch({
      webhook: {
        domain: process.env.DOMAIN,
        port: 3000, // TODO: set port with env?
      },
    });
  } else {
    console.log("Running in long poll mode");

    bot.launch();
  }

  // Create cron job for automated messages
  // for prod on midnight on dev every minute

  const cronId = process.env.CRON_GROUP_ID;

  if (cronId) {
    cron.schedule(
      process.env.NODE_ENV === "production" ? "0 1 * * *" : "* * * * *",
      async () => {
        const message = await getDailyMessage(-1);

        bot.telegram.sendMessage(cronId, message);
      },
      {
        scheduled: true,
        timezone: "Europe/Helsinki",
      }
    );
  }

  // Enable graceful stop
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
} else {
  console.log("missing some environment variables...");
}
