## Структура

- `backend/server.js`
- `backend/package.json`
- `backend/.env`
- `frontend/index.html`
- `frontend/login.html`
- `frontend/register-student.html`
- `frontend/register-company.html`
- `frontend/vacancy.html`
- `frontend/apply.html`
- `frontend/resume.html`
- `frontend/applications.html`
- `frontend/company.html`
- `frontend/vacancy-form.html`
- `frontend/admin.html`
- `frontend/style.css`
- `frontend/app.js`

## Запуск

1. Перейти в папку `backend`:

```powershell
cd "C:\Users\bocka\OneDrive\Рабочий стол\курсовая\backend"
```

2. Установить зависимости:

```powershell
npm.cmd install
```

3. Убедиться, что PostgreSQL запущен и база `job_board` существует

4. Открыть `backend/.env` и вписать свой логин и пароль от PostgreSQL

5. Запустить сервер:

```powershell
npm.cmd run dev
```

6. Открыть сайт:

- [http://localhost:4000](http://localhost:4000)

## Демо-аккаунты

- `student@jobboard.local` / `password123`
- `company@jobboard.local` / `password123`
- `admin@jobboard.local` / `password123`
