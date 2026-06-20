import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";

dotenv.config();

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.resolve(__dirname, "../frontend");
const JQUERY_DIR = path.resolve(__dirname, "node_modules/jquery/dist");
const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET || "student-job-board-secret";
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/job_board";

const pool = new Pool({
  connectionString: DATABASE_URL
});

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'company', 'student')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `ALTER TABLE users
   ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE users
   ADD COLUMN IF NOT EXISTS demo_password TEXT`,
  `ALTER TABLE users
   ADD COLUMN IF NOT EXISTS demo_order INTEGER`,
  `CREATE TABLE IF NOT EXISTS companies (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    website TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS resumes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    experience TEXT NOT NULL,
    education TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS skills (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS vacancies (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    location TEXT NOT NULL,
    employment TEXT NOT NULL,
    salary_from INTEGER,
    salary_to INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
    moderation_note TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS vacancy_skills (
    vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    PRIMARY KEY (vacancy_id, skill_id)
  )`,
  `CREATE TABLE IF NOT EXISTS resume_skills (
    resume_id INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    PRIMARY KEY (resume_id, skill_id)
  )`,
  `CREATE TABLE IF NOT EXISTS applications (
    id SERIAL PRIMARY KEY,
    vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resume_id INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
    cover_letter TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'reviewing', 'accepted', 'declined')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (vacancy_id, student_id)
  )`
];

const defaultSkills = [
  "HTML",
  "CSS",
  "JavaScript",
  "jQuery",
  "Node.js",
  "Express",
  "PostgreSQL",
  "Git"
];

function normalizeSkills(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return [...new Set(
    input
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  )];
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sendError(res, status, message) {
  return res.status(status).json({ message });
}

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      email: user.email
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function authMiddleware(roles = []) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return sendError(res, 401, "Требуется авторизация");
    }

    try {
      const token = header.slice(7);
      const payload = jwt.verify(token, JWT_SECRET);
      if (roles.length > 0 && !roles.includes(payload.role)) {
        return sendError(res, 403, "Доступ запрещен");
      }

      req.auth = payload;
      next();
    } catch {
      return sendError(res, 401, "Недействительный токен");
    }
  };
}

async function runInTransaction(callback) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function initializeDatabase() {
  for (const statement of schemaStatements) {
    await pool.query(statement);
  }
}

export async function resetDatabase() {
  const statements = [
    "DROP TABLE IF EXISTS applications",
    "DROP TABLE IF EXISTS resume_skills",
    "DROP TABLE IF EXISTS vacancy_skills",
    "DROP TABLE IF EXISTS vacancies",
    "DROP TABLE IF EXISTS resumes",
    "DROP TABLE IF EXISTS skills",
    "DROP TABLE IF EXISTS companies",
    "DROP TABLE IF EXISTS users"
  ];

  for (const statement of statements) {
    await pool.query(statement);
  }
}

async function ensureSkillIds(client, skillNames) {
  const ids = [];

  for (const name of normalizeSkills(skillNames)) {
    const result = await client.query(
      `INSERT INTO skills (name)
       VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name]
    );
    ids.push(result.rows[0].id);
  }

  return ids;
}

async function getUserByEmail(client, email) {
  const result = await client.query(
    `SELECT id, email, password_hash, full_name, role
     FROM users
     WHERE LOWER(email) = LOWER($1)`,
    [email]
  );

  return result.rows[0] || null;
}

async function getUserById(client, id) {
  const result = await client.query(
    `SELECT id, email, full_name, role
     FROM users
     WHERE id = $1`,
    [id]
  );

  return result.rows[0] || null;
}

async function listDemoAccounts(client) {
  const result = await client.query(
    `SELECT id, email, full_name, role, demo_password, demo_order
     FROM users
     WHERE is_demo = TRUE
       AND demo_password IS NOT NULL
     ORDER BY demo_order ASC NULLS LAST, id ASC`
  );

  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    password: row.demo_password
  }));
}

async function getCompanyByUserId(client, userId) {
  const result = await client.query(
    `SELECT id, user_id, name, description, website
     FROM companies
     WHERE user_id = $1`,
    [userId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    website: row.website
  };
}

async function getCompanyById(client, companyId) {
  const result = await client.query(
    `SELECT id, user_id, name, description, website
     FROM companies
     WHERE id = $1`,
    [companyId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    website: row.website
  };
}

async function getSkillsForVacancy(client, vacancyId) {
  const result = await client.query(
    `SELECT s.id, s.name
     FROM vacancy_skills vs
     JOIN skills s ON s.id = vs.skill_id
     WHERE vs.vacancy_id = $1
     ORDER BY s.name`,
    [vacancyId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name
  }));
}

async function getSkillsForResume(client, resumeId) {
  const result = await client.query(
    `SELECT s.id, s.name
     FROM resume_skills rs
     JOIN skills s ON s.id = rs.skill_id
     WHERE rs.resume_id = $1
     ORDER BY s.name`,
    [resumeId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name
  }));
}

async function getResumeByUserId(client, userId) {
  const result = await client.query(
    `SELECT id, user_id, summary, experience, education
     FROM resumes
     WHERE user_id = $1`,
    [userId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    summary: row.summary,
    experience: row.experience,
    education: row.education,
    skills: await getSkillsForResume(client, row.id)
  };
}

async function getResumeById(client, resumeId) {
  const result = await client.query(
    `SELECT id, user_id, summary, experience, education
     FROM resumes
     WHERE id = $1`,
    [resumeId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    summary: row.summary,
    experience: row.experience,
    education: row.education,
    skills: await getSkillsForResume(client, row.id)
  };
}

async function getVacancyBaseById(client, vacancyId) {
  const result = await client.query(
    `SELECT id, company_id, title, description, location, employment, salary_from, salary_to, status, moderation_note, created_at
     FROM vacancies
     WHERE id = $1`,
    [vacancyId]
  );

  return result.rows[0] || null;
}

async function formatVacancy(client, row) {
  const company = await getCompanyById(client, row.company_id);
  const skills = await getSkillsForVacancy(client, row.id);

  return {
    id: row.id,
    companyId: row.company_id,
    title: row.title,
    description: row.description,
    location: row.location,
    employment: row.employment,
    salaryFrom: row.salary_from,
    salaryTo: row.salary_to,
    status: row.status,
    moderationNote: row.moderation_note,
    createdAt: row.created_at,
    company,
    skills
  };
}

async function getVacancyById(client, vacancyId, includeRejected = false) {
  const row = await getVacancyBaseById(client, vacancyId);
  if (!row) {
    return null;
  }

  if (!includeRejected && row.status !== "approved") {
    return null;
  }

  const vacancy = await formatVacancy(client, row);
  const countResult = await client.query(
    "SELECT COUNT(*)::int AS total FROM applications WHERE vacancy_id = $1",
    [vacancyId]
  );

  return {
    ...vacancy,
    applicationsCount: countResult.rows[0].total
  };
}

async function listVacancies(client, { skill = "", status = "approved", companyId = null } = {}) {
  const params = [];
  const conditions = [];

  if (companyId !== null) {
    params.push(companyId);
    conditions.push(`v.company_id = $${params.length}`);
  }

  if (status) {
    params.push(status);
    conditions.push(`v.status = $${params.length}`);
  }

  if (skill) {
    params.push(`%${skill.toLowerCase()}%`);
    conditions.push(
      `EXISTS (
        SELECT 1
        FROM vacancy_skills vs
        JOIN skills s ON s.id = vs.skill_id
        WHERE vs.vacancy_id = v.id
          AND LOWER(s.name) LIKE $${params.length}
      )`
    );
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await client.query(
    `SELECT v.id, v.company_id, v.title, v.description, v.location, v.employment, v.salary_from, v.salary_to, v.status, v.moderation_note, v.created_at
     FROM vacancies v
     ${whereClause}
     ORDER BY v.created_at DESC`,
    params
  );

  const items = [];
  for (const row of result.rows) {
    items.push(await formatVacancy(client, row));
  }

  return items;
}

async function listApplicationsForStudent(client, userId) {
  const result = await client.query(
    `SELECT id, vacancy_id, student_id, resume_id, cover_letter, status, created_at
     FROM applications
     WHERE student_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  const items = [];
  for (const row of result.rows) {
    const vacancy = await getVacancyBaseById(client, row.vacancy_id);
    items.push({
      id: row.id,
      vacancyId: row.vacancy_id,
      studentId: row.student_id,
      resumeId: row.resume_id,
      coverLetter: row.cover_letter,
      status: row.status,
      createdAt: row.created_at,
      vacancy: vacancy ? await formatVacancy(client, vacancy) : null
    });
  }

  return items;
}

async function listApplicationsForVacancy(client, vacancyId) {
  const result = await client.query(
    `SELECT a.id, a.vacancy_id, a.student_id, a.resume_id, a.cover_letter, a.status, a.created_at, u.full_name, u.email
     FROM applications a
     JOIN users u ON u.id = a.student_id
     WHERE a.vacancy_id = $1
     ORDER BY a.created_at DESC`,
    [vacancyId]
  );

  const items = [];
  for (const row of result.rows) {
    items.push({
      id: row.id,
      vacancyId: row.vacancy_id,
      studentId: row.student_id,
      resumeId: row.resume_id,
      coverLetter: row.cover_letter,
      status: row.status,
      createdAt: row.created_at,
      student: {
        id: row.student_id,
        fullName: row.full_name,
        email: row.email
      },
      resume: await getResumeById(client, row.resume_id)
    });
  }

  return items;
}

async function buildSessionPayload(client, user) {
  const sessionUser = {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role
  };

  return {
    token: signToken(sessionUser),
    user: sessionUser,
    company: user.role === "company" ? await getCompanyByUserId(client, user.id) : null,
    resume: user.role === "student" ? await getResumeByUserId(client, user.id) : null
  };
}

export async function seedDemoData() {
  await runInTransaction(async (client) => {
    await ensureSkillIds(client, defaultSkills);

    const demoCompanyDescriptionRu = "Простые предложения стажировок для студентов и junior-разработчиков.";
    const demoCompanyDescriptionEn = "Simple internship offers for students and junior developers.";
    const demoResumeRu = {
      summary: "Студент-разработчик в поиске первой frontend-стажировки.",
      experience: "Учебные проекты и небольшие фриланс-лендинги.",
      education: "Технический университет, программная инженерия."
    };
    const demoResumeEn = {
      summary: "Student developer looking for first frontend internship.",
      experience: "Educational projects and small freelance landing pages.",
      education: "Technical university, software engineering."
    };
    const demoVacancy = {
      title: "Frontend-стажер",
      description: "Работа с HTML, CSS и jQuery в дружелюбной команде для студентов.",
      location: "Москва / гибрид",
      employment: "Стажировка",
      salaryFrom: 30000,
      salaryTo: 50000,
      status: "approved",
      moderationNote: "Одобрено администратором"
    };
    const demoVacancyEn = {
      title: "Frontend Intern",
      description: "Work with HTML, CSS and jQuery in a student-friendly team.",
      location: "Moscow / hybrid",
      employment: "Internship",
      moderationNote: "Approved by admin"
    };

    const demoPassword = "password123";
    const demoPasswordHash = await bcrypt.hash(demoPassword, 10);
    const demoUsers = [
      {
        email: "student@jobboard.local",
        fullName: "Anna Student",
        role: "student",
        order: 1
      },
      {
        email: "company@jobboard.local",
        fullName: "Future Tech HR",
        role: "company",
        order: 2
      },
      {
        email: "admin@jobboard.local",
        fullName: "Admin User",
        role: "admin",
        order: 3
      }
    ];

    for (const demoUser of demoUsers) {
      await client.query(
        `INSERT INTO users (email, password_hash, full_name, role, is_demo, demo_password, demo_order)
         VALUES ($1, $2, $3, $4, TRUE, $5, $6)
         ON CONFLICT (email) DO NOTHING`,
        [demoUser.email, demoPasswordHash, demoUser.fullName, demoUser.role, demoPassword, demoUser.order]
      );

      await client.query(
        `UPDATE users
         SET password_hash = $2,
             full_name = $3,
             role = $4,
             is_demo = TRUE,
             demo_password = $5,
             demo_order = $6
         WHERE email = $1`,
        [demoUser.email, demoPasswordHash, demoUser.fullName, demoUser.role, demoPassword, demoUser.order]
      );
    }

    const companyUser = await getUserByEmail(client, "company@jobboard.local");
    const studentUser = await getUserByEmail(client, "student@jobboard.local");

    await client.query(
      `INSERT INTO companies (user_id, name, description, website)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO NOTHING`,
      [
        companyUser.id,
        "Future Tech",
        demoCompanyDescriptionRu,
        "https://futuretech.local"
      ]
    );

    await client.query(
      `UPDATE companies
       SET description = $2,
           website = $3
       WHERE user_id = $1
         AND (description = $4 OR description IS NULL OR description = '')`,
      [companyUser.id, demoCompanyDescriptionRu, "https://futuretech.local", demoCompanyDescriptionEn]
    );

    const company = await getCompanyByUserId(client, companyUser.id);

    const existingResume = await getResumeByUserId(client, studentUser.id);
    let resumeId = existingResume?.id || null;

    if (!resumeId) {
      const resumeResult = await client.query(
        `INSERT INTO resumes (user_id, summary, experience, education)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [studentUser.id, demoResumeRu.summary, demoResumeRu.experience, demoResumeRu.education]
      );

      resumeId = resumeResult.rows[0].id;
    } else {
      await client.query(
        `UPDATE resumes
         SET summary = $2,
             experience = $3,
             education = $4
         WHERE id = $1
           AND summary = $5
           AND experience = $6
           AND education = $7`,
        [
          resumeId,
          demoResumeRu.summary,
          demoResumeRu.experience,
          demoResumeRu.education,
          demoResumeEn.summary,
          demoResumeEn.experience,
          demoResumeEn.education
        ]
      );
    }

    const resumeSkillIds = await ensureSkillIds(client, ["HTML", "CSS", "jQuery"]);
    for (const skillId of resumeSkillIds) {
      await client.query(
        `INSERT INTO resume_skills (resume_id, skill_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [resumeId, skillId]
      );
    }

    const existingDemoVacancy = await client.query(
      `SELECT id
       FROM vacancies
       WHERE company_id = $1
         AND (
           title = $2
           OR title = $3
           OR description = $4
           OR description = $5
         )
       ORDER BY id ASC
       LIMIT 1`,
      [company.id, demoVacancy.title, demoVacancyEn.title, demoVacancy.description, demoVacancyEn.description]
    );

    let vacancyId = existingDemoVacancy.rows[0]?.id || null;

    if (!vacancyId) {
      const vacancyResult = await client.query(
        `INSERT INTO vacancies (company_id, title, description, location, employment, salary_from, salary_to, status, moderation_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          company.id,
          demoVacancy.title,
          demoVacancy.description,
          demoVacancy.location,
          demoVacancy.employment,
          demoVacancy.salaryFrom,
          demoVacancy.salaryTo,
          demoVacancy.status,
          demoVacancy.moderationNote
        ]
      );

      vacancyId = vacancyResult.rows[0].id;
    }

    await client.query(
      `UPDATE vacancies
       SET title = $2,
           description = $3,
           location = $4,
           employment = $5,
           salary_from = $6,
           salary_to = $7,
           status = $8,
           moderation_note = $9
       WHERE id = $1`,
      [
        vacancyId,
        demoVacancy.title,
        demoVacancy.description,
        demoVacancy.location,
        demoVacancy.employment,
        demoVacancy.salaryFrom,
        demoVacancy.salaryTo,
        demoVacancy.status,
        demoVacancy.moderationNote
      ]
    );

    const vacancySkillIds = await ensureSkillIds(client, ["HTML", "CSS", "jQuery"]);
    for (const skillId of vacancySkillIds) {
      await client.query(
        `INSERT INTO vacancy_skills (vacancy_id, skill_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [vacancyId, skillId]
      );
    }
  });
}

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/vendor", express.static(JQUERY_DIR));
  app.use(express.static(FRONTEND_DIR));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/demo-accounts", async (_req, res) => {
    try {
      const demoAccounts = await listDemoAccounts(pool);
      return res.json(demoAccounts);
    } catch {
      return sendError(res, 500, "Не удалось загрузить демо-аккаунты");
    }
  });

  app.post("/api/auth/register/student", async (req, res) => {
    const { email, password, fullName } = req.body;

    if (!email || !password || !fullName) {
      return sendError(res, 400, "Все поля обязательны");
    }

    try {
      const payload = await runInTransaction(async (client) => {
        const existingUser = await getUserByEmail(client, email);
        if (existingUser) {
          throw new Error("USER_EXISTS");
        }

        const passwordHash = await bcrypt.hash(String(password), 10);
        const result = await client.query(
          `INSERT INTO users (email, password_hash, full_name, role)
           VALUES ($1, $2, $3, 'student')
           RETURNING id, email, full_name, role`,
          [String(email).trim(), passwordHash, String(fullName).trim()]
        );

        return buildSessionPayload(client, result.rows[0]);
      });

      return res.status(201).json(payload);
    } catch (error) {
      if (error instanceof Error && error.message === "USER_EXISTS") {
        return sendError(res, 409, "Пользователь уже существует");
      }

      return sendError(res, 500, "Не удалось выполнить регистрацию");
    }
  });

  app.post("/api/auth/register/company", async (req, res) => {
    const { email, password, fullName, companyName, companyDescription, website } = req.body;

    if (!email || !password || !fullName || !companyName || !companyDescription) {
      return sendError(res, 400, "Заполните все обязательные поля");
    }

    try {
      const payload = await runInTransaction(async (client) => {
        const existingUser = await getUserByEmail(client, email);
        if (existingUser) {
          throw new Error("USER_EXISTS");
        }

        const passwordHash = await bcrypt.hash(String(password), 10);
        const userResult = await client.query(
          `INSERT INTO users (email, password_hash, full_name, role)
           VALUES ($1, $2, $3, 'company')
           RETURNING id, email, full_name, role`,
          [String(email).trim(), passwordHash, String(fullName).trim()]
        );

        await client.query(
          `INSERT INTO companies (user_id, name, description, website)
           VALUES ($1, $2, $3, $4)`,
          [
            userResult.rows[0].id,
            String(companyName).trim(),
            String(companyDescription).trim(),
            website ? String(website).trim() : null
          ]
        );

        return buildSessionPayload(client, userResult.rows[0]);
      });

      return res.status(201).json(payload);
    } catch (error) {
      if (error instanceof Error && error.message === "USER_EXISTS") {
        return sendError(res, 409, "Пользователь уже существует");
      }

      return sendError(res, 500, "Не удалось выполнить регистрацию");
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return sendError(res, 400, "Укажите электронную почту и пароль");
    }

    try {
      const client = await pool.connect();
      try {
        const user = await getUserByEmail(client, email);
        if (!user) {
          return sendError(res, 401, "Неверные учетные данные");
        }

        const validPassword = await bcrypt.compare(String(password), user.password_hash);
        if (!validPassword) {
          return sendError(res, 401, "Неверные учетные данные");
        }

        return res.json(await buildSessionPayload(client, user));
      } finally {
        client.release();
      }
    } catch {
      return sendError(res, 500, "Не удалось выполнить вход");
    }
  });

  app.get("/api/skills", async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, name
         FROM skills
         ORDER BY name`
      );

      return res.json(result.rows);
    } catch {
      return sendError(res, 500, "Не удалось загрузить навыки");
    }
  });

  app.get("/api/vacancies", async (req, res) => {
    try {
      const skill = String(req.query.skill || "").trim();
      const items = await listVacancies(pool, {
        skill,
        status: "approved"
      });

      return res.json(items);
    } catch {
      return sendError(res, 500, "Не удалось загрузить вакансии");
    }
  });

  app.get("/api/vacancies/:id", async (req, res) => {
    try {
      const vacancy = await getVacancyById(pool, Number(req.params.id), false);
      if (!vacancy) {
        return sendError(res, 404, "Вакансия не найдена");
      }

      return res.json(vacancy);
    } catch {
      return sendError(res, 500, "Не удалось загрузить вакансию");
    }
  });

  app.post("/api/vacancies", authMiddleware(["company"]), async (req, res) => {
    const { title, description, location, employment, salaryFrom, salaryTo, skills } = req.body;
    const skillList = normalizeSkills(skills);

    if (!title || !description || !location || !employment || skillList.length === 0) {
      return sendError(res, 400, "Заполните название, описание, локацию, тип занятости и навыки");
    }

    try {
      const vacancy = await runInTransaction(async (client) => {
        const company = await getCompanyByUserId(client, req.auth.sub);
        if (!company) {
          throw new Error("COMPANY_NOT_FOUND");
        }

        const result = await client.query(
          `INSERT INTO vacancies (company_id, title, description, location, employment, salary_from, salary_to, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
           RETURNING id, company_id, title, description, location, employment, salary_from, salary_to, status, moderation_note, created_at`,
          [
            company.id,
            String(title).trim(),
            String(description).trim(),
            String(location).trim(),
            String(employment).trim(),
            parseNumber(salaryFrom),
            parseNumber(salaryTo)
          ]
        );

        const vacancyId = result.rows[0].id;
        const skillIds = await ensureSkillIds(client, skillList);
        for (const skillId of skillIds) {
          await client.query(
            `INSERT INTO vacancy_skills (vacancy_id, skill_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [vacancyId, skillId]
          );
        }

        return formatVacancy(client, result.rows[0]);
      });

      return res.status(201).json(vacancy);
    } catch (error) {
      if (error instanceof Error && error.message === "COMPANY_NOT_FOUND") {
        return sendError(res, 400, "Профиль компании не найден");
      }

      return sendError(res, 500, "Не удалось создать вакансию");
    }
  });

  app.get("/api/company/vacancies", authMiddleware(["company"]), async (req, res) => {
    try {
      const client = await pool.connect();
      try {
        const company = await getCompanyByUserId(client, req.auth.sub);
        if (!company) {
          return sendError(res, 400, "Профиль компании не найден");
        }

        const vacancies = await listVacancies(client, {
          companyId: company.id,
          status: null
        });

        const detailed = [];
        for (const vacancy of vacancies) {
          detailed.push({
            ...vacancy,
            applications: await listApplicationsForVacancy(client, vacancy.id)
          });
        }

        return res.json({
          company,
          vacancies: detailed
        });
      } finally {
        client.release();
      }
    } catch {
      return sendError(res, 500, "Не удалось загрузить кабинет компании");
    }
  });

  app.get("/api/admin/vacancies", authMiddleware(["admin"]), async (_req, res) => {
    try {
      const vacancies = await listVacancies(pool, {
        status: null
      });

      return res.json(vacancies);
    } catch {
      return sendError(res, 500, "Не удалось загрузить список модерации");
    }
  });

  app.patch("/api/vacancies/:id/moderate", authMiddleware(["admin"]), async (req, res) => {
    const { status, moderationNote } = req.body;

    if (!["approved", "rejected"].includes(String(status))) {
      return sendError(res, 400, "Используйте статус approved (одобрена) или rejected (отклонена)");
    }

    try {
      const result = await pool.query(
        `UPDATE vacancies
         SET status = $2,
             moderation_note = $3
         WHERE id = $1
         RETURNING id, company_id, title, description, location, employment, salary_from, salary_to, status, moderation_note, created_at`,
        [Number(req.params.id), String(status), moderationNote ? String(moderationNote).trim() : null]
      );

      if (result.rows.length === 0) {
        return sendError(res, 404, "Вакансия не найдена");
      }

      return res.json(await formatVacancy(pool, result.rows[0]));
    } catch {
      return sendError(res, 500, "Не удалось выполнить модерацию");
    }
  });

  app.post("/api/resumes/me", authMiddleware(["student"]), async (req, res) => {
    const { summary, experience, education, skills } = req.body;
    const skillList = normalizeSkills(skills);

    if (!summary || !experience || !education || skillList.length === 0) {
      return sendError(res, 400, "Заполните разделы о себе, опыте, образовании и навыках");
    }

    try {
      const resume = await runInTransaction(async (client) => {
        const existingResume = await getResumeByUserId(client, req.auth.sub);
        let resumeId;

        if (existingResume) {
          await client.query(
            `UPDATE resumes
             SET summary = $2,
                 experience = $3,
                 education = $4,
                 updated_at = NOW()
             WHERE id = $1`,
            [existingResume.id, String(summary).trim(), String(experience).trim(), String(education).trim()]
          );
          resumeId = existingResume.id;
          await client.query("DELETE FROM resume_skills WHERE resume_id = $1", [resumeId]);
        } else {
          const created = await client.query(
            `INSERT INTO resumes (user_id, summary, experience, education)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [req.auth.sub, String(summary).trim(), String(experience).trim(), String(education).trim()]
          );
          resumeId = created.rows[0].id;
        }

        const skillIds = await ensureSkillIds(client, skillList);
        for (const skillId of skillIds) {
          await client.query(
            `INSERT INTO resume_skills (resume_id, skill_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [resumeId, skillId]
          );
        }

        return getResumeByUserId(client, req.auth.sub);
      });

      return res.status(201).json(resume);
    } catch {
      return sendError(res, 500, "Не удалось сохранить резюме");
    }
  });

  app.get("/api/resumes/me", authMiddleware(["student"]), async (req, res) => {
    try {
      const resume = await getResumeByUserId(pool, req.auth.sub);
      if (!resume) {
        return sendError(res, 404, "Резюме не найдено");
      }

      return res.json(resume);
    } catch {
      return sendError(res, 500, "Не удалось загрузить резюме");
    }
  });

  app.post("/api/vacancies/:id/applications", authMiddleware(["student"]), async (req, res) => {
    const { resumeId, coverLetter } = req.body;

    if (!resumeId || !coverLetter) {
      return sendError(res, 400, "Требуются резюме и сопроводительное письмо");
    }

    try {
      const application = await runInTransaction(async (client) => {
        const vacancy = await getVacancyBaseById(client, Number(req.params.id));
        if (!vacancy || vacancy.status !== "approved") {
          throw new Error("VACANCY_NOT_FOUND");
        }

        const resume = await getResumeByUserId(client, req.auth.sub);
        if (!resume || resume.id !== Number(resumeId)) {
          throw new Error("RESUME_NOT_FOUND");
        }

        const result = await client.query(
          `INSERT INTO applications (vacancy_id, student_id, resume_id, cover_letter)
           VALUES ($1, $2, $3, $4)
           RETURNING id, vacancy_id, student_id, resume_id, cover_letter, status, created_at`,
          [vacancy.id, req.auth.sub, resume.id, String(coverLetter).trim()]
        );

        return {
          id: result.rows[0].id,
          vacancyId: result.rows[0].vacancy_id,
          studentId: result.rows[0].student_id,
          resumeId: result.rows[0].resume_id,
          coverLetter: result.rows[0].cover_letter,
          status: result.rows[0].status,
          createdAt: result.rows[0].created_at
        };
      });

      return res.status(201).json(application);
    } catch (error) {
      if (error instanceof Error && error.message === "VACANCY_NOT_FOUND") {
        return sendError(res, 404, "Вакансия не найдена");
      }

      if (error instanceof Error && error.message === "RESUME_NOT_FOUND") {
        return sendError(res, 400, "Резюме не найдено");
      }

      if (error && String(error.message || "").includes("applications_vacancy_id_student_id_key")) {
        return sendError(res, 409, "Отклик уже существует");
      }

      return sendError(res, 500, "Не удалось создать отклик");
    }
  });

  app.get("/api/applications/my", authMiddleware(["student"]), async (req, res) => {
    try {
      return res.json(await listApplicationsForStudent(pool, req.auth.sub));
    } catch {
      return sendError(res, 500, "Не удалось загрузить отклики");
    }
  });

  app.patch("/api/applications/:id/status", authMiddleware(["company"]), async (req, res) => {
    const { status } = req.body;

    if (!["reviewing", "accepted", "declined"].includes(String(status))) {
      return sendError(res, 400, "Используйте статус reviewing (на рассмотрении), accepted (принят) или declined (отклонен)");
    }

    try {
      const client = await pool.connect();
      try {
        const company = await getCompanyByUserId(client, req.auth.sub);
        if (!company) {
          return sendError(res, 400, "Профиль компании не найден");
        }

        const applicationResult = await client.query(
          `SELECT a.id, a.vacancy_id
           FROM applications a
           WHERE a.id = $1`,
          [Number(req.params.id)]
        );

        if (applicationResult.rows.length === 0) {
          return sendError(res, 404, "Отклик не найден");
        }

        const vacancy = await getVacancyBaseById(client, applicationResult.rows[0].vacancy_id);
        if (!vacancy || vacancy.company_id !== company.id) {
          return sendError(res, 403, "Доступ запрещен");
        }

        const updated = await client.query(
          `UPDATE applications
           SET status = $2
           WHERE id = $1
           RETURNING id, vacancy_id, student_id, resume_id, cover_letter, status, created_at`,
          [Number(req.params.id), String(status)]
        );

        return res.json({
          id: updated.rows[0].id,
          vacancyId: updated.rows[0].vacancy_id,
          studentId: updated.rows[0].student_id,
          resumeId: updated.rows[0].resume_id,
          coverLetter: updated.rows[0].cover_letter,
          status: updated.rows[0].status,
          createdAt: updated.rows[0].created_at
        });
      } finally {
        client.release();
      }
    } catch {
      return sendError(res, 500, "Не удалось обновить статус отклика");
    }
  });

  app.get("/", (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, "index.html"));
  });

  return app;
}

export async function closeDatabase() {
  await pool.end();
}

export async function startServer() {
  await initializeDatabase();
  await seedDemoData();

  const app = createApp();
  app.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
  });
}

if (process.argv[1] === __filename) {
  startServer().catch((error) => {
    console.error("Не удалось запустить сервер");
    console.error(error);
    process.exit(1);
  });
}
