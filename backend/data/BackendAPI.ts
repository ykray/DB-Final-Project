import Pool from '../src/Pool';
import SpellChecker from 'spellchecker';
import chalk from 'chalk';

// Types
import {
  Answer,
  BestAnswer,
  KarmaVote,
  Question,
  SearchScope,
} from '../src/Types';

// Utils
import log from '../utils/Logger';
import pool from '../src/Pool';

export default class API {
  static getTopicFeed = (req: any, res: any) => {
    const topicPath: string = req.params.topicPath;
    const query = {
      text: `--sql
        SELECT *
        FROM Questions
        WHERE topic::text LIKE '%' || $1 || '%'
        ORDER BY q_timestamp DESC
        LIMIT 10;
      `,
      values: [topicPath],
    };

    const feedResults: any[] = [];

    log.info(req.params.topicPath);
    Pool.query(query)
      .then((results) => {
        // 1. Get all questions matching query
        const questions = results.rows;
        const q_promises: any = [];

        // 2. For each question, get its' answers
        questions.map((question) => {
          q_promises.push(
            new Promise((resolve, reject) => {
              API.Questions.getAnswers(question.qid).then((answers) => {
                feedResults.push({
                  question,
                  answers,
                });
                resolve(true);
              });
            })
          );
        });

        Promise.all(q_promises).then(() => {
          log.info(feedResults);
          res.status(200).send(feedResults);
        });
      })
      .catch((error) => {
        log.fatal(error);
        res.status(400).send(error);
      });
  };

  static getAllTopics = () => {
    return new Promise((resolve, reject) => {
      Pool.query(
        `--sql
          SELECT t.topic_path
          FROM topics t;
        `
      )
        .then((res) => {
          resolve(res.rows);
        })
        .catch((error) => {
          log.fatal(error);
          reject(error);
        });
    });
  };

  static getSpellingSuggestions = (string: string) => {
    return new Promise((resolve, reject) => {
      const numSuggestions = 5;
      const corrections = SpellChecker.getCorrectionsForMisspelling(
        string
      ).slice(0, numSuggestions);

      log.info(corrections);
      resolve(corrections);
    });
  };

  static getHotQuestions = () => {
    const query = {
      text: `--sql
        SELECT *
        FROM Questions
        ORDER BY q_timestamp DESC
        LIMIT 10;
      `,
    };

    return new Promise((resolve, reject) => {
      const feedResults: any[] = [];

      Pool.query(query)
        .then((res) => {
          // 1. Get all questions matching query
          const questions = res.rows;
          const q_promises: any = [];

          // 2. For each question, get its' answers
          questions.map((question) => {
            q_promises.push(
              new Promise((resolve, reject) => {
                API.Questions.getAnswers(question.qid).then((answers) => {
                  feedResults.push({
                    question,
                    answers,
                  });
                  resolve(true);
                });
              })
            );
          });

          Promise.all(q_promises).then(() => {
            // log.info(feedResults);
            resolve(feedResults);
          });
        })
        .catch((error) => {
          log.fatal(error);
          reject(error);
        });
    });
  };

  // Search API
  static Search = class {
    // Full text search all questions
    static search = (searchQuery: string, searchScope: SearchScope) => {
      const query_questions = {
        text: `--sql
          SELECT q.*
          FROM Questions q
          WHERE q.title ILIKE '%' || $1 || '%'
          OR q.body ILIKE '%' || $1 || '%'
          OR q.topic ILIKE '%' || $1 || '%'
        `,
        values: [searchQuery],
      };
      const query_answers = {
        text: `--sql
          SELECT q.*
          FROM Answers a
            JOIN Questions q ON a.qid = q.qid
          WHERE a.body ILIKE '%' || $1 || '%'
          LIMIT 20;
        `,
        values: [searchQuery],
      };
      const query_all = {
        // (OLD) - Basic text search
        // text: `--sql
        //   -- Search questions
        //   SELECT q.*
        //   FROM Questions q
        //   WHERE q.title ILIKE '%' || $1 || '%'
        //   OR q.body ILIKE '%' || $1 || '%'
        //   OR q.topic ILIKE '%' || $1 || '%'
        //   UNION
        //   -- Search answers
        //   SELECT q.*
        //   FROM Answers a
        //     JOIN Questions q ON a.qid = q.qid
        //   WHERE a.body ILIKE '%' || $1 || '%'
        //   LIMIT 20;
        // `,
        // (NEW) - TSVECTOR-powered, lexeme text search
        text: `--sql
          WITH variables (term) AS (VALUES ($1))
          SELECT DISTINCT ON (q.qid) q.*,
            TO_TSVECTOR(q.title || '' || q.body || '' || COALESCE(a.body, '')) AS tsv_search,
            TS_RANK(TO_TSVECTOR(q.title || '' || q.body || '' || COALESCE(a.body, '')),
            PLAINTO_TSQUERY(v.term)) AS rank
          FROM
            variables v,
            questions q
              JOIN answers a ON q.qid = a.qid
          WHERE
            TO_TSVECTOR(q.title || '' || q.body || '' || COALESCE(a.body, '')) @@ PLAINTO_TSQUERY(v.term) AND
            q.topic = 'Science.Biology'
          ORDER BY q.qid, rank DESC;
        `,
        values: [searchQuery],
      };
      const query =
        searchScope === SearchScope.Questions
          ? query_questions
          : SearchScope.Answers
          ? query_answers
          : query_all;

      return new Promise((resolve, reject) => {
        const searchResults: any[] = [];

        Pool.query(query)
          .then((res) => {
            // 1. Get all questions matching query
            const questions = res.rows;
            const q_promises: any = [];

            // 2. For each question, get its' answers
            questions.map((question) => {
              q_promises.push(
                new Promise((resolve, reject) => {
                  API.Questions.getAnswers(question.qid).then((answers) => {
                    searchResults.push({
                      question,
                      answers,
                    });
                    resolve(true);
                  });
                })
              );
            });

            Promise.all(q_promises).then(() => {
              console.log(
                '\n' +
                  chalk.bold.yellowBright(searchResults.length) +
                  ` search result${
                    searchResults.length !== 1 ? 's' : ''
                  } for ` +
                  chalk.italic.greenBright(`'${searchQuery}'`) +
                  ', in scope: ' +
                  chalk.bold.blue(searchScope)
              );
              // log.info(searchResults);
              resolve(searchResults);
            });
          })
          .catch((error) => {
            log.fatal(error);
            reject(error);
          });
      });
    };
  };

  // Users API
  static Users = class {
    static login = (req: any, res: any) => {
      const { user } = req;
      res.json(user);
    };

    static logout = (req: any, res: any, next: any) => {
      req.session.destroy((error: any) => {
        if (error) {
          log.fatal(error);
          res.status(400).send(error);
        }
        console.log(
          chalk.bold.blueBright('Logged out:'),
          chalk.greenBright(req.user)
        );
        req.logout();
        // res.clearCookie('connect.sid');
        res.sendStatus(200);
      });
    };

    static currentUser = (req: any, res: any) => {
      log.debug(req.user);
      if (req.user) {
        res.status(200).send(req.user);
      } else {
        res.sendStatus(400);
      }
    };

    static updateBio = (req: any, res: any) => {
      const newBio: string = req.body.newBio;
      log.debug(req.user);

      const query = {
        text: `--sql
          UPDATE Users
          SET bio = $2
          WHERE uid::text = $1
          `,
        values: [req.user, newBio.trim()],
      };

      Pool.query(query)
        .then((results) => {
          const test = {
            uid: req.user,
            bio: newBio,
          };
          console.log(chalk.blueBright(chalk.bold('UPDATED')), test);
          res.status(200).send(results);
        })
        .catch((error) => {
          log.fatal('Failed to update bio:', error);
          res.status(400).send(error);
        });
    };

    static askQuestion = (req: any, res: any) => {
      const question: Question = req.body;
      const query = {
        text: `--sql
          INSERT INTO questions(uid, title, body, topic)
          VALUES ($1, $2, $3, $4)
          RETURNING qid
          `,
        values: [req.user, question.title, question.body, question.topic],
      };

      pool
        .query(query)
        .then((results) => {
          // Question asked!
          console.log(
            chalk.blueBright(chalk.bold('NEW'), 'question:'),
            question
          );
          res.status(200).send(results.rows[0]);
        })
        .catch((error) => {
          log.fatal(error);
          res.sendStatus(400);
        });
    };

    static getUserQuestions = (req: any, res: any) => {
      const query = {
        text: `--sql
          SELECT *
          FROM questions
          WHERE uid::text = $1;
          `,
        values: [req.params.uid],
      };

      const feedResults: any[] = [];

      Pool.query(query)
        .then((results) => {
          // 1. Get all questions matching query
          const questions = results.rows;
          const q_promises: any = [];

          // 2. For each question, get its' answers
          questions.map((question) => {
            q_promises.push(
              new Promise((resolve, reject) => {
                API.Questions.getAnswers(question.qid).then((answers) => {
                  feedResults.push({
                    question,
                    answers,
                  });
                  resolve(true);
                });
              })
            );
          });

          Promise.all(q_promises).then(() => {
            // log.info(feedResults);
            res.status(200).send(feedResults);
          });
        })
        .catch((error) => {
          log.fatal(error);
          res.status(400).send(error);
        });
    };

    static getUserFromUsername = (username: string) => {
      const query = {
        text: `--sql
          SELECT *
          FROM users
          WHERE username = $1;
          `,
        values: [username.trim()],
      };

      return new Promise((resolve, reject) => {
        Pool.query(query)
          .then((res) => {
            const user = res.rows[0];
            resolve(user);
          })
          .catch((error) => {
            log.fatal(error);
            reject(error);
          });
      });
    };

    static getUser = (uid: string) => {
      const query = {
        text: `--sql
          SELECT *
          FROM Users
          WHERE uid::text = $1;
          `,
        values: [uid],
      };

      return new Promise((resolve, reject) => {
        Pool.query(query)
          .then((res) => {
            const user = res.rows[0];
            resolve(user);
          })
          .catch((error) => {
            log.fatal(error);
            reject(error);
          });
      });
    };
  };

  // Questions API
  static Questions = class {
    static getQuestionPost = (qid: string) => {
      const query = {
        text: `--sql
          SELECT
            q.*
          FROM Questions q
          WHERE qid::TEXT = $1
          FETCH FIRST ROW ONLY;
        `,
        values: [qid],
      };

      return new Promise((resolve, reject) => {
        Pool.query(query)
          .then((res) => {
            const question = res.rows[0];
            // Get answers to question
            this.getAnswers(qid).then((answers: Answer[]) => {
              // Get best answer (if exists)
              this.getBestAnswer(qid).then((bestAnswer: BestAnswer) => {
                if (bestAnswer) {
                  const bestAnswer_index = answers.findIndex(
                    (x: Answer) => x.qid === bestAnswer.qid
                  );
                  answers[bestAnswer_index].bestAnswer = true;
                }
                answers = answers.map((answer) => ({
                  ...answer,
                  q_uid: 's',
                }));

                log.debug(answers);

                resolve({
                  question,
                  answers,
                });
              });
            });
          })
          .catch((error) => {
            log.fatal(error);
            reject(error);
          });
      });
    };

    static getBestAnswer = (qid: string) => {
      const query = {
        text: `--sql
          SELECT *
          FROM BestAnswers b
          WHERE b.qid = $1;
        `,
        values: [qid],
      };

      return new Promise((resolve, reject) => {
        Pool.query(query)
          .then((res: any) => {
            resolve(res.rows[0]);
          })
          .catch((error) => {
            log.fatal(error);
            reject(error);
          });
      });
    };

    static getAnswers = (qid: string) => {
      const query = {
        text: `--sql
          SELECT
            a.qid,
            a.body,
            a.uid,
            a.a_timestamp
          FROM Answers a
            JOIN Questions q ON a.qid = q.qid
          WHERE a.qid::TEXT = $1;
        `,
        values: [qid],
      };

      return new Promise((resolve, reject) => {
        Pool.query(query)
          .then((res: any) => {
            resolve(res.rows);
          })
          .catch((error) => {
            log.fatal(error);
            reject(error);
          });
      });
    };
  };

  // Answers API
  static Answers = class {
    static best = (req: any, res: any) => {
      const query = {
        text: `--sql
          INSERT INTO bestAnswer(qid, uid)
          VALUES ($1, $2)
          ON CONFLICT (qid, uid)
            DO UPDATE SET uid = $2;
        `,
        values: [req.body.qid, req.body.uid],
      };

      return new Promise((resolve, reject) => {
        pool
          .query(query)
          .then((results) => {
            resolve(results);
          })
          .catch((error) => {
            reject(error);
          });
      });
    };

    static checkIfVoted = (
      answerID: any,
      voter_uid: string
    ): Promise<number> => {
      const _answerID = JSON.parse(answerID);
      const query = {
        text: `--sql
          SELECT vote
          FROM Karma
          WHERE
            qid::TEXT = $1 AND
            uid::TEXT = $2 AND
            voter_uid::TEXT = $3
        `,
        values: [_answerID.qid, _answerID.uid, voter_uid],
      };

      return new Promise((resolve, reject) => {
        Pool.query(query)
          .then((res) => {
            const vote = res.rowCount > 0 ? res.rows[0].vote : 0;
            resolve(vote);
          })
          .catch((error) => {
            log.fatal(error);
            reject(error);
          });
      });
    };

    static getKarmaCount = (answerID: any): Promise<number> => {
      const parsed = JSON.parse(answerID);
      const query = {
        text: `--sql
          SELECT SUM(vote)
          FROM Karma
          WHERE qid::TEXT = $1 AND uid::TEXT = $2;
        `,
        values: [parsed.qid, parsed.uid],
      };

      return new Promise((resolve, reject) => {
        Pool.query(query)
          .then((res) => {
            const sum: number = Number(res.rows[0].sum) || 0;
            resolve(sum);
          })
          .catch((error) => {
            log.fatal(error);
            reject(error);
          });
      });
    };

    static vote = (karmaVote: KarmaVote) => {
      const query = {
        text: `--sql
          INSERT INTO Karma(qid, uid, voter_uid, vote)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (qid, uid, voter_uid)
            DO UPDATE SET vote = $4;
        `,
        values: [
          karmaVote.qid,
          karmaVote.uid,
          karmaVote.voter_uid,
          karmaVote.vote,
        ],
      };

      return new Promise((resolve, reject) => {
        Pool.query(query)
          .then((res) => {
            log.info(
              chalk.bold('voter_uid:'),
              chalk.yellow(karmaVote.voter_uid),
              `${
                karmaVote.vote === 1
                  ? chalk.italic.green('upvoted')
                  : chalk.italic.redBright('downvoted')
              } ${chalk.bold('answer:')}`,
              `\n${chalk.bold('qid:')} ${chalk.blue(
                karmaVote.qid
              )}\n${chalk.bold('uid:')} ${chalk.yellow(karmaVote.uid)}`
            );
            resolve(res);
          })
          .catch((error) => {
            log.fatal(error);
            reject(error);
          });
      });
    };
  };
}
