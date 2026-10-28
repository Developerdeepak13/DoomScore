/* ==========================================================
   DoomScore – frontend logic
   Talks to the FastAPI backend: POST /predict
   ========================================================== */

(() => {
  "use strict";

  /* ---------- Config ---------- */
  const API_BASE_URL = "https://doomscore.onrender.com";
  const PREDICT_URL = `${API_BASE_URL}/predict`;
  const REQUEST_TIMEOUT_MS = 20000;
  const SCORE_MAX = 10;               // scale used for the gauge
  const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 60; // r = 60 in the SVG

  /* ---------- Validation rules (mirror the Pydantic model) ---------- */
  const FIELD_RULES = {
    age:                     { label: "Age",                  type: "int",   min: 10, max: 100 },
    gender:                  { label: "Gender",               type: "choice" },
    country:                 { label: "Country",              type: "text" },
    academic_level:          { label: "Academic level",       type: "choice" },
    most_used_platform:      { label: "Most used platform",   type: "choice" },
    purpose_of_use:          { label: "Purpose of use",       type: "choice" },
    avg_daily_usage_hours:   { label: "Daily usage hours",    type: "float", min: 0, max: 24 },
    daily_unlocks:           { label: "Daily unlocks",        type: "int",   min: 0 },
    study_hours:             { label: "Study hours",          type: "float", min: 0, max: 24 },
    physical_activity_hours: { label: "Physical activity",    type: "float", min: 0, max: 24 },
    sleep_hours_per_night:   { label: "Sleep hours",          type: "float", min: 0, max: 24 },
    stress_level:            { label: "Stress level",         type: "choice" },
  };

  /* ---------- DOM ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const form        = $("#predict-form");
  const formAlert   = $("#form-alert");
  const submitBtn   = $("#submit-btn");
  const resetBtn    = $("#reset-btn");
  const retryBtn    = $("#retry-btn");
  const resultCard  = $("#result-card");
  const gaugeFill   = $("#gauge-fill");
  const scoreValue  = $("#score-value");
  const scoreBadge  = $("#score-badge");
  const scoreMsg    = $("#score-message");
  const chipsList   = $("#summary-chips");
  const errorTitle  = $("#error-title");
  const errorMsg    = $("#error-message");
  const apiStatus   = $("#api-status");

  let countAnimation = null;

  /* ==========================================================
     Helpers: UI state
     ========================================================== */
  const setResultState = (state) => { resultCard.dataset.state = state; };

  function setLoading(isLoading) {
    submitBtn.classList.toggle("is-loading", isLoading);
    submitBtn.disabled = isLoading;
    $(".btn__label", submitBtn).textContent = isLoading ? "Predicting…" : "Predict score";
    form.setAttribute("aria-busy", String(isLoading));
  }

  function showFormAlert(message, items = []) {
    formAlert.innerHTML = "";
    const p = document.createElement("strong");
    p.textContent = message;
    formAlert.appendChild(p);

    if (items.length) {
      const ul = document.createElement("ul");
      items.forEach((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        ul.appendChild(li);
      });
      formAlert.appendChild(ul);
    }
    formAlert.hidden = false;
  }

  const hideFormAlert = () => { formAlert.hidden = true; formAlert.innerHTML = ""; };

  function setFieldError(name, message) {
    const slot = $(`[data-error-for="${name}"]`);
    if (!slot) return;
    slot.textContent = message || "";
    const field = slot.closest(".field");
    if (field) field.classList.toggle("has-error", Boolean(message));
  }

  function clearAllErrors() {
    Object.keys(FIELD_RULES).forEach((name) => setFieldError(name, ""));
    hideFormAlert();
  }

  function focusFirstError() {
    const invalid = $(".field.has-error");
    if (!invalid) return;
    const control = $("input, select", invalid);
    if (control) control.focus({ preventScroll: false });
  }

  /* ==========================================================
     Reading + validating the form
     ========================================================== */
  function readFormValues() {
    const raw = {};
    Object.keys(FIELD_RULES).forEach((name) => {
      const rule = FIELD_RULES[name];
      if (rule.type === "choice" && form.elements[name] instanceof RadioNodeList) {
        raw[name] = form.elements[name].value;          // radio groups
      } else {
        raw[name] = (form.elements[name]?.value ?? "").trim();
      }
    });
    return raw;
  }

  /** Validates raw strings, returns { payload, errors } with correctly typed values. */
  function validate(raw) {
    const errors = {};
    const payload = {};

    Object.entries(FIELD_RULES).forEach(([name, rule]) => {
      const value = raw[name];

      if (value === "" || value == null) {
        errors[name] = rule.type === "choice"
          ? `Please select ${rule.label.toLowerCase()}.`
          : `${rule.label} is required.`;
        return;
      }

      if (rule.type === "int" || rule.type === "float") {
        const num = Number(value);
        if (!Number.isFinite(num)) {
          errors[name] = `${rule.label} must be a number.`;
          return;
        }
        if (rule.type === "int" && !Number.isInteger(num)) {
          errors[name] = `${rule.label} must be a whole number.`;
          return;
        }
        if (rule.min !== undefined && num < rule.min) {
          errors[name] = `${rule.label} must be at least ${rule.min}.`;
          return;
        }
        if (rule.max !== undefined && num > rule.max) {
          errors[name] = `${rule.label} must be at most ${rule.max}.`;
          return;
        }
        payload[name] = num;
        return;
      }

      payload[name] = value;
    });

    return { payload, errors };
  }

  /* ==========================================================
     API call
     ========================================================== */
  class ApiError extends Error {
    constructor(kind, message, details = []) {
      super(message);
      this.kind = kind;        // "validation" | "server" | "network" | "timeout" | "unknown"
      this.details = details;  // [{ field, message }]
    }
  }

  /** Turns FastAPI's 422 `detail` array into [{ field, message }]. */
  function parseValidationDetail(detail) {
    if (!Array.isArray(detail)) return [];
    return detail.map((item) => {
      const loc = Array.isArray(item.loc) ? item.loc : [];
      const field = loc.filter((part) => part !== "body").join(".");
      return { field, message: item.msg || "Invalid value." };
    });
  }

  async function requestPrediction(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(PREDICT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new ApiError("timeout", "The server took too long to respond. Please try again.");
      }
      throw new ApiError(
        "network",
        `Couldn't reach the API at ${API_BASE_URL}. Make sure the FastAPI server is running and try again.`
      );
    } finally {
      clearTimeout(timer);
    }

    let body = null;
    try { body = await response.json(); } catch { /* non-JSON body */ }

    if (response.ok) {
      const score = body?.predicted_mental_health_score;
      if (typeof score !== "number" || Number.isNaN(score)) {
        throw new ApiError("unknown", "The server returned an unexpected response.");
      }
      return score;
    }

    if (response.status === 422) {
      throw new ApiError(
        "validation",
        "The server rejected some of the values.",
        parseValidationDetail(body?.detail)
      );
    }

    if (response.status >= 500) {
      throw new ApiError(
        "server",
        "The model hit an internal error while predicting. Check the backend logs for details."
      );
    }

    const detailText = typeof body?.detail === "string" ? body.detail : `Request failed (HTTP ${response.status}).`;
    throw new ApiError("unknown", detailText);
  }

  /* ==========================================================
     Rendering the result
     ========================================================== */
  function getScoreBand(score) {
    if (score >= 7) {
      return { tone: "good", label: "Healthy range", message: "Habits suggest a relatively positive mental wellbeing outlook." };
    }
    if (score >= 5) {
      return { tone: "mid", label: "Moderate", message: "Mixed signals – small changes to sleep, activity or screen time could help." };
    }
    return { tone: "low", label: "Needs attention", message: "Habits point to elevated risk. Consider reducing screen time and talking to someone you trust." };
  }

  function animateNumber(target, duration = 1300) {
    cancelAnimationFrame(countAnimation);
    const start = performance.now();
    const tick = (now) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      scoreValue.textContent = (target * eased).toFixed(2);
      if (progress < 1) countAnimation = requestAnimationFrame(tick);
    };
    countAnimation = requestAnimationFrame(tick);
  }

  function renderSummaryChips(payload) {
    chipsList.innerHTML = "";
    const items = [
      ["Sleep", `${payload.sleep_hours_per_night}h`],
      ["Screen", `${payload.avg_daily_usage_hours}h`],
      ["Stress", payload.stress_level],
      ["Platform", payload.most_used_platform],
    ];
    items.forEach(([key, value]) => {
      const li = document.createElement("li");
      li.append(`${key}: `);
      const b = document.createElement("b");
      b.textContent = value;
      li.appendChild(b);
      chipsList.appendChild(li);
    });
  }

  function renderResult(score, payload) {
    const band = getScoreBand(score);
    resultCard.dataset.tone = band.tone;
    scoreBadge.textContent = band.label;
    scoreMsg.textContent = band.message;
    renderSummaryChips(payload);

    // Reset gauge, show the card, then animate to the target.
    gaugeFill.style.transition = "none";
    gaugeFill.style.strokeDashoffset = GAUGE_CIRCUMFERENCE;
    scoreValue.textContent = "0.00";
    setResultState("success");

    requestAnimationFrame(() => requestAnimationFrame(() => {
      const ratio = Math.min(Math.max(score / SCORE_MAX, 0), 1);
      gaugeFill.style.transition = "";
      gaugeFill.style.strokeDashoffset = GAUGE_CIRCUMFERENCE * (1 - ratio);
      animateNumber(score);
    }));
  }

  function renderError(title, message) {
    errorTitle.textContent = title;
    errorMsg.textContent = message;
    setResultState("error");
  }

  function scrollToResultOnMobile() {
    if (window.matchMedia("(max-width: 920px)").matches) {
      resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /* ==========================================================
     Event handlers
     ========================================================== */
  async function handleSubmit(event) {
    event.preventDefault();
    clearAllErrors();

    const { payload, errors } = validate(readFormValues());

    if (Object.keys(errors).length) {
      Object.entries(errors).forEach(([name, msg]) => setFieldError(name, msg));
      showFormAlert("Please fix the highlighted fields and try again.");
      focusFirstError();
      return;
    }

    setLoading(true);
    setResultState("loading");
    scrollToResultOnMobile();

    try {
      const score = await requestPrediction(payload);
      renderResult(score, payload);
      setApiStatus(true);
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoading(false);
    }
  }

  function handleApiError(err) {
    if (!(err instanceof ApiError)) {
      console.error(err);
      renderError("Unexpected error", "Something went wrong. Please try again.");
      return;
    }

    if (err.kind === "validation") {
      const messages = [];
      err.details.forEach(({ field, message }) => {
        if (FIELD_RULES[field]) setFieldError(field, message);
        messages.push(FIELD_RULES[field] ? `${FIELD_RULES[field].label}: ${message}` : message);
      });
      showFormAlert("The server couldn't accept your input.", messages);
      renderError("Invalid input", "Please correct the highlighted fields and submit again.");
      focusFirstError();
      return;
    }

    if (err.kind === "network" || err.kind === "timeout") setApiStatus(false);

    const titles = {
      network: "Can't reach the server",
      timeout: "Request timed out",
      server:  "Server error",
      unknown: "Unexpected response",
    };
    renderError(titles[err.kind] || "Something went wrong", err.message);
  }

  function handleReset() {
    form.reset();
    clearAllErrors();
    cancelAnimationFrame(countAnimation);
    setResultState("idle");
    delete resultCard.dataset.tone;
  }

  /* Clear a field's error as soon as the user edits it. */
  function handleFieldInput(event) {
    const name = event.target.name;
    if (name && FIELD_RULES[name]) setFieldError(name, "");
  }

  /* ==========================================================
     API health indicator (GET /)
     ========================================================== */
  function setApiStatus(online) {
    apiStatus.dataset.state = online ? "online" : "offline";
    $(".status__text", apiStatus).textContent = online ? "API online" : "API offline";
  }

  async function checkApiHealth() {
    try {
      const res = await fetch(`${API_BASE_URL}/`, { method: "GET" });
      setApiStatus(res.ok);
    } catch {
      setApiStatus(false);
    }
  }

  /* ---------- Init ---------- */
  form.addEventListener("submit", handleSubmit);
  form.addEventListener("input", handleFieldInput);
  form.addEventListener("change", handleFieldInput);
  resetBtn.addEventListener("click", handleReset);
  retryBtn.addEventListener("click", () => {
    setResultState("idle");
    form.requestSubmit();
  });

  gaugeFill.style.strokeDasharray = GAUGE_CIRCUMFERENCE;
  gaugeFill.style.strokeDashoffset = GAUGE_CIRCUMFERENCE;
  checkApiHealth();
})();