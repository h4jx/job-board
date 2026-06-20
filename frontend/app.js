const SESSION_KEY = "job-board-session";
const ROLE_LABELS = {
  student: "студент",
  company: "компания",
  admin: "админ"
};
const STATUS_LABELS = {
  draft: "черновик",
  pending: "на модерации",
  approved: "одобрена",
  rejected: "отклонена",
  submitted: "отправлен",
  reviewing: "на рассмотрении",
  accepted: "принят",
  declined: "отклонен"
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (symbol) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[symbol]);
}

function getSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function updateSession(patch) {
  const session = getSession();
  if (!session) {
    return;
  }

  saveSession({ ...session, ...patch });
}

function getToken() {
  const session = getSession();
  return session ? session.token : "";
}

function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function showMessage(selector, text, type) {
  const box = $(selector);
  box.removeClass("message-info message-success message-error");
  box.addClass(`message-${type}`);
  box.text(text);
}

function hideMessage(selector) {
  const box = $(selector);
  box.removeClass("message-info message-success message-error");
  box.text("");
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function request(path, options = {}) {
  return $.ajax({
    url: path,
    method: options.method || "GET",
    data: options.data ? JSON.stringify(options.data) : undefined,
    contentType: "application/json",
    headers: {
      ...authHeaders(),
      ...(options.headers || {})
    }
  });
}

function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function formatSalary(vacancy) {
  if (!vacancy.salaryFrom && !vacancy.salaryTo) {
    return "Зарплата не указана";
  }

  return `${vacancy.salaryFrom || "-"} - ${vacancy.salaryTo || "-"} руб.`;
}

function skillChips(skills) {
  return (skills || [])
    .map((skill) => `<span class="chip">${skill.name}</span>`)
    .join("");
}

function vacancyCard(vacancy) {
  return `
    <article class="card vacancy-card">
      <div class="between">
        <div>
          <h2>${vacancy.title}</h2>
          <div class="muted small">${vacancy.company ? vacancy.company.name : "Компания"} / ${vacancy.location}</div>
        </div>
        <span class="status status-${vacancy.status}">${statusLabel(vacancy.status)}</span>
      </div>
      <div>${vacancy.description}</div>
      <div class="muted small">${vacancy.employment} / ${formatSalary(vacancy)}</div>
      <div class="chip-list">${skillChips(vacancy.skills)}</div>
      <a class="button-link" href="/vacancy.html?id=${vacancy.id}">Открыть вакансию</a>
    </article>
  `;
}

function ensureRole(roles) {
  const session = getSession();
  if (!session || !roles.includes(session.user.role)) {
    window.location.href = "/login.html";
    return null;
  }

  return session;
}

function updateHeader() {
  const session = getSession();
  const userLabel = $("#user-label");
  const logoutButton = $("#logout-button");

  if (session) {
    userLabel.text(`${session.user.fullName} (${roleLabel(session.user.role)})`);
    logoutButton.show();
  } else {
    userLabel.text("Гость");
    logoutButton.hide();
  }

  logoutButton.on("click", function () {
    clearSession();
    window.location.href = "/login.html";
  });
}

function initHome() {
  function loadSkills() {
    request("/api/skills")
      .done((skills) => {
        const select = $("#skill-filter");
        select.html(`<option value="">Все навыки</option>`);
        skills.forEach((skill) => {
          select.append(`<option value="${skill.name}">${skill.name}</option>`);
        });
      })
      .fail(() => showMessage("#page-message", "Не удалось загрузить навыки", "error"));
  }

  function loadVacancies(skill = "") {
    hideMessage("#page-message");
    request(`/api/vacancies${skill ? `?skill=${encodeURIComponent(skill)}` : ""}`)
      .done((vacancies) => {
        const list = $("#vacancy-list");
        if (vacancies.length === 0) {
          list.html(`<div class="card">Вакансии не найдены.</div>`);
          return;
        }

        list.html(vacancies.map(vacancyCard).join(""));
      })
      .fail(() => showMessage("#page-message", "Не удалось загрузить вакансии", "error"));
  }

  $("#skill-filter").on("change", function () {
    loadVacancies($(this).val());
  });

  loadSkills();
  loadVacancies();
}

function initVacancyPage() {
  const vacancyId = getQueryParam("id");
  if (!vacancyId) {
    showMessage("#page-message", "Не передан идентификатор вакансии", "error");
    return;
  }

  request(`/api/vacancies/${vacancyId}`)
    .done((vacancy) => {
      const session = getSession();
      $("#vacancy-view").html(`
        <div class="panel">
          <div class="between">
            <div>
              <h1>${vacancy.title}</h1>
              <div class="muted">${vacancy.company.name} / ${vacancy.location}</div>
            </div>
            <span class="status status-${vacancy.status}">${statusLabel(vacancy.status)}</span>
          </div>
          <p>${vacancy.description}</p>
          <p><strong>Тип занятости:</strong> ${vacancy.employment}</p>
          <p><strong>Зарплата:</strong> ${formatSalary(vacancy)}</p>
          <p><strong>Откликов:</strong> ${vacancy.applicationsCount}</p>
          <div class="chip-list">${skillChips(vacancy.skills)}</div>
          <div class="row" style="margin-top: 18px;">
            <a class="button-link" href="/apply.html?id=${vacancy.id}">Откликнуться</a>
            ${session && session.user.role === "student" ? `<a class="button-link button-muted" href="/resume.html">Редактировать резюме</a>` : ""}
          </div>
        </div>
      `);
    })
    .fail(() => showMessage("#page-message", "Вакансия не найдена", "error"));
}

function initLoginPage() {
  let demoAccounts = [];

  function fillDemoAccount(account) {
    $("#email").val(account.email);
    $("#password").val(account.password);
  }

  function renderDemoAccounts(accounts) {
    const container = $("#demo-accounts");
    demoAccounts = Array.isArray(accounts) ? accounts : [];

    if (demoAccounts.length === 0) {
      container.text("Демо-аккаунты пока не настроены.");
      return;
    }

    container.html(`
      <div><strong>Демо-аккаунты из базы данных</strong></div>
      <div class="demo-list">
        ${demoAccounts
          .map(
            (account, index) => `
              <div class="demo-item">
                <div>
                  <div><strong>${escapeHtml(account.fullName)}</strong> (${roleLabel(account.role)})</div>
                  <div class="muted small">${escapeHtml(account.email)} / пароль: ${escapeHtml(account.password)}</div>
                </div>
                <button type="button" class="button-inline demo-fill-button" data-demo-index="${index}">Подставить</button>
              </div>
            `
          )
          .join("")}
      </div>
    `);

    if (!$("#email").val()) {
      $("#email").val(demoAccounts[0].email);
    }

    if (!$("#password").val()) {
      $("#password").val(demoAccounts[0].password);
    }
  }

  $("#demo-accounts").on("click", ".demo-fill-button", function () {
    const account = demoAccounts[Number($(this).data("demo-index"))];
    if (!account) {
      return;
    }

    fillDemoAccount(account);
  });

  request("/api/demo-accounts")
    .done((accounts) => {
      renderDemoAccounts(accounts);
    })
    .fail(() => {
      $("#demo-accounts").text("Не удалось загрузить демо-аккаунты.");
    });

  $("#login-form").on("submit", function (event) {
    event.preventDefault();
    hideMessage("#page-message");

    request("/api/auth/login", {
      method: "POST",
      data: {
        email: $("#email").val(),
        password: $("#password").val()
      }
    })
      .done((session) => {
        saveSession(session);
        if (session.user.role === "student") {
          window.location.href = "/resume.html";
          return;
        }

        if (session.user.role === "company") {
          window.location.href = "/company.html";
          return;
        }

        window.location.href = "/admin.html";
      })
      .fail((error) => {
        showMessage("#page-message", error.responseJSON?.message || "Не удалось выполнить вход", "error");
      });
  });
}

function initStudentRegisterPage() {
  $("#student-register-form").on("submit", function (event) {
    event.preventDefault();
    hideMessage("#page-message");

    request("/api/auth/register/student", {
      method: "POST",
      data: {
        fullName: $("#fullName").val(),
        email: $("#email").val(),
        password: $("#password").val()
      }
    })
      .done((session) => {
        saveSession(session);
        window.location.href = "/resume.html";
      })
      .fail((error) => {
        showMessage("#page-message", error.responseJSON?.message || "Не удалось зарегистрировать студента", "error");
      });
  });
}

function initCompanyRegisterPage() {
  $("#company-register-form").on("submit", function (event) {
    event.preventDefault();
    hideMessage("#page-message");

    request("/api/auth/register/company", {
      method: "POST",
      data: {
        fullName: $("#fullName").val(),
        email: $("#email").val(),
        password: $("#password").val(),
        companyName: $("#companyName").val(),
        companyDescription: $("#companyDescription").val(),
        website: $("#website").val()
      }
    })
      .done((session) => {
        saveSession(session);
        window.location.href = "/company.html";
      })
      .fail((error) => {
        showMessage("#page-message", error.responseJSON?.message || "Не удалось зарегистрировать компанию", "error");
      });
  });
}

function initResumePage() {
  const session = ensureRole(["student"]);
  if (!session) {
    return;
  }

  function loadResume() {
    request("/api/resumes/me")
      .done((resume) => {
        updateSession({ resume });
        $("#summary").val(resume.summary);
        $("#experience").val(resume.experience);
        $("#education").val(resume.education);
        $("#skills").val(resume.skills.map((skill) => skill.name).join(", "));
        $("#resume-preview").html(`
          <div class="card">
            <h2>Текущее резюме</h2>
            <p>${resume.summary}</p>
            <p><strong>Опыт:</strong> ${resume.experience}</p>
            <p><strong>Образование:</strong> ${resume.education}</p>
            <div class="chip-list">${skillChips(resume.skills)}</div>
          </div>
        `);
      })
      .fail(() => {
        $("#resume-preview").html(`<div class="card">Резюме еще не создано.</div>`);
      });
  }

  $("#resume-form").on("submit", function (event) {
    event.preventDefault();
    hideMessage("#page-message");

    request("/api/resumes/me", {
      method: "POST",
      data: {
        summary: $("#summary").val(),
        experience: $("#experience").val(),
        education: $("#education").val(),
        skills: $("#skills")
          .val()
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      }
    })
      .done((resume) => {
        updateSession({ resume });
        showMessage("#page-message", "Резюме сохранено", "success");
        loadResume();
      })
      .fail((error) => {
        showMessage("#page-message", error.responseJSON?.message || "Не удалось сохранить резюме", "error");
      });
  });

  loadResume();
}

function initApplicationsPage() {
  const session = ensureRole(["student"]);
  if (!session) {
    return;
  }

  request("/api/applications/my")
    .done((applications) => {
      if (applications.length === 0) {
        $("#application-list").html(`<div class="card">У вас пока нет откликов.</div>`);
        return;
      }

      $("#application-list").html(
        applications
          .map(
            (item) => `
              <article class="card application-card">
                <div class="between">
                  <h2>${item.vacancy ? item.vacancy.title : "Вакансия"}</h2>
                  <span class="status status-${item.status}">${statusLabel(item.status)}</span>
                </div>
                <div class="muted">${item.vacancy ? item.vacancy.company.name : ""}</div>
                <div>${item.coverLetter}</div>
              </article>
            `
          )
          .join("")
      );
    })
    .fail(() => showMessage("#page-message", "Не удалось загрузить отклики", "error"));
}

function initApplyPage() {
  const session = ensureRole(["student"]);
  if (!session) {
    return;
  }

  const vacancyId = getQueryParam("id");
  if (!vacancyId) {
    showMessage("#page-message", "Не передан идентификатор вакансии", "error");
    return;
  }

  request(`/api/vacancies/${vacancyId}`)
    .done((vacancy) => {
      $("#vacancy-short").html(`
        <div class="card">
          <h2>${vacancy.title}</h2>
          <div class="muted">${vacancy.company.name} / ${vacancy.location}</div>
          <div class="chip-list" style="margin-top: 10px;">${skillChips(vacancy.skills)}</div>
        </div>
      `);
    })
    .fail(() => showMessage("#page-message", "Вакансия не найдена", "error"));

  request("/api/resumes/me")
    .done((resume) => {
      updateSession({ resume });
      $("#resume-state").html(`<div class="card">Резюме загружено: ${resume.summary}</div>`);
    })
    .fail(() => {
      $("#resume-state").html(`<div class="card">Сначала создайте резюме на странице студента.</div>`);
    });

  $("#apply-form").on("submit", function (event) {
    event.preventDefault();
    const currentSession = getSession();
    if (!currentSession || !currentSession.resume) {
      showMessage("#page-message", "Сначала создайте резюме", "error");
      return;
    }

    request(`/api/vacancies/${vacancyId}/applications`, {
      method: "POST",
      data: {
        resumeId: currentSession.resume.id,
        coverLetter: $("#coverLetter").val()
      }
    })
      .done(() => {
        showMessage("#page-message", "Отклик отправлен", "success");
        setTimeout(() => {
          window.location.href = "/applications.html";
        }, 700);
      })
      .fail((error) => {
        showMessage("#page-message", error.responseJSON?.message || "Не удалось отправить отклик", "error");
      });
  });
}

function initCompanyPage() {
  const session = ensureRole(["company"]);
  if (!session) {
    return;
  }

  function loadDashboard() {
    request("/api/company/vacancies")
      .done((payload) => {
        $("#company-name").text(payload.company.name);
        if (payload.vacancies.length === 0) {
          $("#company-vacancies").html(`<div class="card">Вы еще не создали ни одной вакансии.</div>`);
          return;
        }

        $("#company-vacancies").html(
          payload.vacancies
            .map(
              (vacancy) => `
                <article class="card vacancy-card">
                  <div class="between">
                    <div>
                      <h2>${vacancy.title}</h2>
                      <div class="muted">${vacancy.location} / ${vacancy.employment}</div>
                    </div>
                    <span class="status status-${vacancy.status}">${statusLabel(vacancy.status)}</span>
                  </div>
                  <div>${vacancy.description}</div>
                  <div class="chip-list">${skillChips(vacancy.skills)}</div>
                  <div class="stack">
                    ${
                      vacancy.applications.length === 0
                        ? `<div class="card">Пока нет откликов.</div>`
                        : vacancy.applications
                            .map(
                              (application) => `
                                <div class="card">
                                  <div class="between">
                                    <strong>${application.student.fullName}</strong>
                                    <span class="status status-${application.status}">${statusLabel(application.status)}</span>
                                  </div>
                                  <div class="muted small">${application.student.email}</div>
                                  <p>${application.coverLetter}</p>
                                  <p><strong>Резюме:</strong> ${application.resume.summary}</p>
                                  <p><strong>Опыт:</strong> ${application.resume.experience}</p>
                                  <div class="chip-list">${skillChips(application.resume.skills)}</div>
                                  <div class="row" style="margin-top: 12px;">
                                    <select class="status-select" data-application-id="${application.id}">
                                      <option value="submitted" disabled>отправлен</option>
                                      <option value="reviewing">на рассмотрении</option>
                                      <option value="accepted">принят</option>
                                      <option value="declined">отклонен</option>
                                    </select>
                                    <button class="button-inline save-status" data-application-id="${application.id}">Сохранить статус</button>
                                  </div>
                                </div>
                              `
                            )
                            .join("")
                    }
                  </div>
                </article>
              `
            )
            .join("")
        );

        payload.vacancies.forEach((vacancy) => {
          vacancy.applications.forEach((application) => {
            $(`.status-select[data-application-id="${application.id}"]`).val(application.status);
          });
        });
      })
      .fail(() => showMessage("#page-message", "Не удалось загрузить кабинет компании", "error"));
  }

  $(document).on("click", ".save-status", function () {
    const applicationId = $(this).data("application-id");
    const status = $(`.status-select[data-application-id="${applicationId}"]`).val();

    request(`/api/applications/${applicationId}/status`, {
      method: "PATCH",
      data: { status }
    })
      .done(() => {
        showMessage("#page-message", "Статус отклика обновлен", "success");
        loadDashboard();
      })
      .fail((error) => {
        showMessage("#page-message", error.responseJSON?.message || "Не удалось обновить статус", "error");
      });
  });

  loadDashboard();
}

function initVacancyFormPage() {
  const session = ensureRole(["company"]);
  if (!session) {
    return;
  }

  $("#vacancy-form").on("submit", function (event) {
    event.preventDefault();

    request("/api/vacancies", {
      method: "POST",
      data: {
        title: $("#title").val(),
        description: $("#description").val(),
        location: $("#location").val(),
        employment: $("#employment").val(),
        salaryFrom: $("#salaryFrom").val(),
        salaryTo: $("#salaryTo").val(),
        skills: $("#skills")
          .val()
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      }
    })
      .done(() => {
        showMessage("#page-message", "Вакансия отправлена на модерацию", "success");
        setTimeout(() => {
          window.location.href = "/company.html";
        }, 700);
      })
      .fail((error) => {
        showMessage("#page-message", error.responseJSON?.message || "Не удалось создать вакансию", "error");
      });
  });
}

function initAdminPage() {
  const session = ensureRole(["admin"]);
  if (!session) {
    return;
  }

  function loadVacancies() {
    request("/api/admin/vacancies")
      .done((vacancies) => {
        if (vacancies.length === 0) {
          $("#moderation-list").html(`<div class="card">Нет вакансий для модерации.</div>`);
          return;
        }

        $("#moderation-list").html(
          vacancies
            .map(
              (vacancy) => `
                <article class="card vacancy-card">
                  <div class="between">
                    <div>
                      <h2>${vacancy.title}</h2>
                      <div class="muted">${vacancy.company.name} / ${vacancy.location}</div>
                    </div>
                    <span class="status status-${vacancy.status}">${statusLabel(vacancy.status)}</span>
                  </div>
                  <div>${vacancy.description}</div>
                  <div class="chip-list">${skillChips(vacancy.skills)}</div>
                  <div class="row">
                    <button class="button-inline approve-button" data-vacancy-id="${vacancy.id}">Одобрить</button>
                    <button class="button-inline button-danger reject-button" data-vacancy-id="${vacancy.id}">Отклонить</button>
                  </div>
                </article>
              `
            )
            .join("")
        );
      })
      .fail(() => showMessage("#page-message", "Не удалось загрузить страницу модерации", "error"));
  }

  $(document).on("click", ".approve-button, .reject-button", function () {
    const vacancyId = $(this).data("vacancy-id");
    const status = $(this).hasClass("approve-button") ? "approved" : "rejected";

    request(`/api/vacancies/${vacancyId}/moderate`, {
      method: "PATCH",
      data: {
        status,
        moderationNote: "Проверено администратором"
      }
    })
      .done(() => {
        showMessage("#page-message", "Статус вакансии обновлен", "success");
        loadVacancies();
      })
      .fail((error) => {
        showMessage("#page-message", error.responseJSON?.message || "Не удалось промодерировать вакансию", "error");
      });
  });

  loadVacancies();
}

$(function () {
  updateHeader();

  const page = $("body").data("page");
  const pageMap = {
    home: initHome,
    vacancy: initVacancyPage,
    login: initLoginPage,
    "register-student": initStudentRegisterPage,
    "register-company": initCompanyRegisterPage,
    resume: initResumePage,
    applications: initApplicationsPage,
    apply: initApplyPage,
    company: initCompanyPage,
    "vacancy-form": initVacancyFormPage,
    admin: initAdminPage
  };

  if (pageMap[page]) {
    pageMap[page]();
  }
});
