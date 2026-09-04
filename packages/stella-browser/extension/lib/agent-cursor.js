const CURSOR_ASSET =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAC4AAAAwCAYAAABuZUjcAAAABmJLR0QA/wD/AP+gvaeTAAAEeklEQVRoge2YXWgcVRTHf2dndzOzm6+KiUUMhNooNG0qeQhNJaZpEiNFm6ItPhQSxYBiBeubCmJ9ENsH0QcRpakWLJogQdpSUCJpkgcJJimIGLGlsMU8pEpr0jQfm93k+DCTr5pkszuzTcH9wzCXYff+f+cy95xzBzLKKKN7UpLoB6pqAk3AY8AvwFciMpluMFdSVVNV+3S5/lTVZlX1bTTfqlLVl1VVY19e09HGAR07HtHYyMx8AIOqWrdRbIlWrRRg8tzfRKMGoxdvE2mJMHLqJrMTc+VAp6r2qmpN+lGXKxH4rwBU3M+0BohqgKkZP8Ptk/Q33SDSNk18SquALieA/XfrFVpzc6pqCPgjfj32UKQlwtSMn6gG7CCw75obZMuhICWNQiAEwGXgY+CMiIxvCLgD3wycHjl1k+H2yWXQ80FMi0EsF0r2QXkj5BcCMA60AydF5OeNAPcB/bMTc+X9TTeYuGX8B3rCDxMGTBowlQVbd8HuetheBmI7DAFtQJuIXLkr4A58HdAZaZvmt9bYqtB3jsMPwN5qqK2EosKF6S4B54ELwKCIzKUN3IHvjU9p1feHZ7g16k8IvXQcy4JHS6ChHBp2QFH+wrTXgR+AHqBHRK6mA7wG6Br6RulrlaSgY6Z9j5v2eMuDsHcr1BdDRQEEF/PQMNAHDDjXoIiMugJ34Htjk1R9cRj+iaYGHTMhnrU4DoagcjPUFED1fVAWhvBiILPAWeClOwNIFnw/cLbrJHSfcw8dzwKxwDKVkKVYlhK2lG05sDMMFaZQZxgIdIjIQTfgPuD30b945P1X7XznJbRlOeMlz44SYA/GHJArIhPzLElVOScDfJRfaKe8dEOvpVTK8xlgfHd9eqE3IbxCgGoMgO+WrnZK4CJyG2jbXmbnaa+hCy14AT+fkcVTGIi9OVu8WHGAVhG7uHgFHbaUZywfnxLkAH6yoAt4XEQOrJQSUwJ3eo+h2kpvoB8OwYdWgNcIkINcBupFpFZEflqNwU0L2lZUaFdEN9B12cInZoBSfFHgGFAmIj8mMncD/jXYZTwV6LCpHM01eDcYIBu5BuwRkfdEJLoe85TBnb7iUsOO5KFzTOVYnp/n/AbYm2+niPQl4+/2tHK+KN/uPZKBPpHnp8bwAZwGDorIWLLGbsEvgN0wrQc6ZCpv5xlU2NDHReRFEYmnYuwWfBAYqS9e30Z8Pdeg3jAAPheRt9wYuwJ3WoDOigK7y1sL+slsWfpOH3Hj6xrcUU/QB7s2rw5dHII3gn6Aq0CziMy6NfUCvBugtpBVK+Kbpp9sJAo8n8pGXEmuwZ20OPzEJlbsPZ62fJTaNh+IyKBrYkdefbzpKwtDeIWGqRk/wBXghEdegHfgA2EfbMtZ/p4/i0GOfVY5IiLTHnkB2MvhgQbAPm6N+Rb76X329F0i0umRz4K8WvFBIF5p+hZOLofs1hTgHY880iNV/XZOVbs1rt0a1zn7U3THRnMllKrmq2qHqsadq0NV8xP/8x6Rqlqqam00R0YZZZTR/0T/AonhuxCuMeKdAAAAAElFTkSuQmCC";

const ROOT_ID = "__stella_agent_cursor_root__";
const CONTROLLER_PROPERTY = "__stellaAgentCursorController";
const DEFAULT_GLOW_COLOR = "#339cff";

/**
 * Installs the page-side cursor. This function is deliberately self-contained:
 * its source is serialized into CDP Runtime.evaluate for both Stella browser
 * backends, so the two surfaces run the same artwork and motion engine.
 */
function installAgentCursor(host, assetUrl, glowColor) {
  const OUTER_SIZE = 24;
  const CENTER = OUTER_SIZE / 2;
  const IMAGE_WIDTH = 23;
  const IMAGE_HEIGHT = 24;
  const IMAGE_X = 12;
  const IMAGE_Y = -2.5;
  const IMAGE_ROTATION = 44;
  const CLICK_ANGLE = -44;
  const SMALL_MOVE_DISTANCE = 196;
  const SCOOT_ROTATION = 70;
  const ARRIVAL_DISTANCE = 0.85;
  const ARRIVAL_VELOCITY = 12;
  const THINK_DURATION_SECONDS = 1.41;
  const THINK_PERIOD_SECONDS = 0.66;
  const THINK_AMPLITUDE_DEGREES = 12.5;
  const SPRING_STEP = 1 / 240;
  const FRAME_SECONDS = 1 / 60;
  const MAX_CATCH_UP_SECONDS = 1;
  const SETTLE_THRESHOLD = 0.001 * 60;
  const PATH_CONFIG = {
    arcFlow: 0.5783555327868779,
    arcSize: 0.2765523188064277,
    boundsMargin: 20,
    candidateCount: 20,
    clickAngleDegrees: CLICK_ANGLE,
    endpointHandle: 0.15,
    startHandle: 0.41960295031576633,
  };
  const SPRINGS = {
    stretch: { dampingFraction: 0.85, response: 0.2 },
    visibility: { dampingFraction: 0.86, response: 0.42 },
    scootProgress: { dampingFraction: 0.94, response: 0.19 },
    position: { dampingFraction: 0.9, response: 0.19 },
    rotation: { dampingFraction: 0.9, response: 0.12 },
    scootRotation: { dampingFraction: 0.82, response: 0.055 },
    scootStretch: { dampingFraction: 0.86, response: 0.12 },
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const mix = (from, to, amount) => from + (to - from) * amount;
  const round = (value) => Math.round(value * 1_000) / 1_000;
  const now = () =>
    typeof performance === "undefined" ? Date.now() : performance.now();
  const distance = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);
  const normalize = (point) => {
    const magnitude = Math.hypot(point.x, point.y);
    return magnitude < 0.001
      ? { x: 1, y: 0 }
      : { x: point.x / magnitude, y: point.y / magnitude };
  };
  const normalizeDegrees = (degrees) => {
    const result = degrees % 360;
    return result < 0 ? result + 360 : result;
  };
  const shortestDegreeDelta = (from, to) => {
    let delta = to - from;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    return delta;
  };
  const shortestRadianDelta = (from, to) => {
    let delta = to - from;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return delta;
  };
  const clickVector = (degrees) => {
    const radians = degrees * (Math.PI / 180);
    return { x: Math.sin(radians), y: -Math.cos(radians) };
  };
  const midpoint = (from, to) => ({
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2,
  });
  const cubicPoint = (start, control1, control2, end, progress) => {
    const inverse = 1 - progress;
    const a = inverse * inverse * inverse;
    const b = 3 * inverse * inverse * progress;
    const c = 3 * inverse * progress * progress;
    const d = progress * progress * progress;
    return {
      x: start.x * a + control1.x * b + control2.x * c + end.x * d,
      y: start.y * a + control1.y * b + control2.y * c + end.y * d,
    };
  };
  const cubicTangent = (start, segment, progress) => {
    const inverse = 1 - progress;
    return {
      x:
        3 * inverse * inverse * (segment.control1.x - start.x) +
        6 * inverse * progress * (segment.control2.x - segment.control1.x) +
        3 * progress * progress * (segment.end.x - segment.control2.x),
      y:
        3 * inverse * inverse * (segment.control1.y - start.y) +
        6 * inverse * progress * (segment.control2.y - segment.control1.y) +
        3 * progress * progress * (segment.end.y - segment.control2.y),
    };
  };
  const pointOnPath = (path, progress) => {
    const bounded = clamp(progress, 0, 1);
    const scaled =
      bounded === 1 ? path.segments.length - 1 : bounded * path.segments.length;
    const index = Math.floor(scaled);
    const segment = path.segments[index];
    const previous = path.segments[index - 1];
    const start = index === 0 ? path.start : previous.end;
    const localProgress = bounded === 1 ? 1 : scaled - index;
    return {
      point: cubicPoint(
        start,
        segment.control1,
        segment.control2,
        segment.end,
        localProgress,
      ),
      tangent: cubicTangent(start, segment, localProgress),
    };
  };
  const tangentRotation = (tangent) => {
    if (distance({ x: 0, y: 0 }, tangent) < 0.001) {
      return normalizeDegrees(CLICK_ANGLE);
    }
    const unit = normalize(tangent);
    return normalizeDegrees(Math.atan2(unit.y, unit.x) * (180 / Math.PI) + 90);
  };
  const boundedControl = (bounds, point, vector, desiredDistance) => {
    let usableDistance = desiredDistance;
    if (vector.x < 0)
      usableDistance = Math.min(usableDistance, point.x / -vector.x);
    if (vector.x > 0) {
      usableDistance = Math.min(
        usableDistance,
        (bounds.width - point.x) / vector.x,
      );
    }
    if (vector.y < 0)
      usableDistance = Math.min(usableDistance, point.y / -vector.y);
    if (vector.y > 0) {
      usableDistance = Math.min(
        usableDistance,
        (bounds.height - point.y) / vector.y,
      );
    }
    return {
      x: point.x + vector.x * Math.max(0, usableDistance),
      y: point.y + vector.y * Math.max(0, usableDistance),
    };
  };
  const straightPath = (start, end, startControl, endControl) => ({
    arc: null,
    end,
    segments: [{ control1: startControl, control2: endControl, end }],
    start,
  });
  const curvedPath = (
    start,
    end,
    startControl,
    arcIn,
    arc,
    arcOut,
    endControl,
  ) => ({
    arc,
    end,
    segments: [
      { control1: startControl, control2: arcIn, end: arc },
      { control1: arcOut, control2: endControl, end },
    ],
    start,
  });
  const pathMetrics = (path, bounds) => {
    let length = 0;
    let angleChangeEnergy = 0;
    let maxAngleChange = 0;
    let totalTurn = 0;
    let previousAngle = null;
    let previousPoint = path.start;
    let segmentStart = path.start;
    let staysInBounds =
      bounds == null ||
      (path.start.x >= PATH_CONFIG.boundsMargin &&
        path.start.x <= bounds.width - PATH_CONFIG.boundsMargin &&
        path.start.y >= PATH_CONFIG.boundsMargin &&
        path.start.y <= bounds.height - PATH_CONFIG.boundsMargin);
    for (const segment of path.segments) {
      for (let step = 1; step <= 24; step += 1) {
        const point = cubicPoint(
          segmentStart,
          segment.control1,
          segment.control2,
          segment.end,
          step / 24,
        );
        length += distance(previousPoint, point);
        if (bounds != null) {
          staysInBounds =
            staysInBounds &&
            point.x >= PATH_CONFIG.boundsMargin &&
            point.x <= bounds.width - PATH_CONFIG.boundsMargin &&
            point.y >= PATH_CONFIG.boundsMargin &&
            point.y <= bounds.height - PATH_CONFIG.boundsMargin;
        }
        const delta = {
          x: point.x - previousPoint.x,
          y: point.y - previousPoint.y,
        };
        if (distance({ x: 0, y: 0 }, delta) > 0.01) {
          const angle = Math.atan2(delta.y, delta.x);
          if (previousAngle != null) {
            const change = shortestRadianDelta(previousAngle, angle);
            angleChangeEnergy += change * change;
            maxAngleChange = Math.max(maxAngleChange, Math.abs(change));
            totalTurn += Math.abs(change);
          }
          previousAngle = angle;
        }
        previousPoint = point;
      }
      segmentStart = segment.end;
    }
    return {
      angleChangeEnergy,
      length,
      maxAngleChange,
      staysInBounds,
      totalTurn,
    };
  };
  const directionalPenalty = (path) => {
    const clickDirection = clickVector(CLICK_ANGLE);
    const travel = normalize({
      x: path.end.x - path.start.x,
      y: path.end.y - path.start.y,
    });
    return clamp(
      (-(travel.x * clickDirection.x + travel.y * clickDirection.y) - 0.08) /
        0.92,
      0,
      1,
    );
  };
  const pathScore = (path, metrics) => {
    const directDistance = Math.max(1, distance(path.start, path.end));
    const detour = Math.max(0, metrics.length / directDistance - 1);
    return (
      metrics.length +
      detour * 320 +
      metrics.angleChangeEnergy * 140 +
      metrics.maxAngleChange * 180 +
      metrics.totalTurn * 18 +
      directionalPenalty(path) * 90 +
      (path.arc == null ? 0 : 45)
    );
  };
  const choosePath = (bounds, start, end) => {
    const targetDirection = clickVector(CLICK_ANGLE);
    const directDistance = distance(start, end);
    const delta = { x: end.x - start.x, y: end.y - start.y };
    const travelDirection = normalize(delta);
    const startHandle = Math.max(
      48,
      Math.min(
        640,
        directDistance * PATH_CONFIG.startHandle,
        directDistance * 0.9,
      ),
    );
    const endHandle = Math.max(
      48,
      Math.min(
        640,
        directDistance * PATH_CONFIG.endpointHandle,
        directDistance * 0.9,
      ),
    );
    const endDirection = { x: -targetDirection.x, y: -targetDirection.y };
    const startControl = boundedControl(
      bounds,
      start,
      targetDirection,
      startHandle,
    );
    const endControl = boundedControl(bounds, end, endDirection, endHandle);
    const normal = { x: -travelDirection.y, y: travelDirection.x };
    const naturalSign =
      normal.x * targetDirection.x + normal.y * targetDirection.y >= 0 ? 1 : -1;
    const naturalNormal = {
      x: normal.x * naturalSign,
      y: normal.y * naturalSign,
    };
    const middle = midpoint(start, end);
    const candidates = [
      straightPath(start, end, startControl, endControl),
      straightPath(
        start,
        end,
        boundedControl(bounds, start, targetDirection, startHandle * 0.65),
        boundedControl(bounds, end, endDirection, endHandle * 0.65),
      ),
    ];
    const arcDistance = Math.max(
      50,
      Math.min(520, directDistance * PATH_CONFIG.arcSize),
    );
    const arcHandleDistance = Math.max(
      38,
      Math.min(440, directDistance * PATH_CONFIG.arcFlow),
    );
    for (const distanceScale of [0.55, 0.8, 1.05]) {
      for (const handleScale of [0.65, 1, 1.35]) {
        for (const sign of [1, -1]) {
          const arcNormal = {
            x: naturalNormal.x * sign,
            y: naturalNormal.y * sign,
          };
          const arc = {
            x:
              middle.x +
              arcNormal.x * arcDistance * distanceScale +
              targetDirection.x * startHandle * 0.16,
            y:
              middle.y +
              arcNormal.y * arcDistance * distanceScale +
              targetDirection.y * startHandle * 0.16,
          };
          const handle = arcHandleDistance * handleScale;
          candidates.push(
            curvedPath(
              start,
              end,
              startControl,
              {
                x: arc.x - travelDirection.x * handle,
                y: arc.y - travelDirection.y * handle,
              },
              arc,
              {
                x: arc.x + travelDirection.x * handle,
                y: arc.y + travelDirection.y * handle,
              },
              endControl,
            ),
          );
        }
      }
    }
    let bestInBounds = null;
    let bestInBoundsScore = Number.POSITIVE_INFINITY;
    let bestAny = candidates[0];
    let bestAnyScore = Number.POSITIVE_INFINITY;
    for (const candidate of candidates.slice(0, PATH_CONFIG.candidateCount)) {
      const metrics = pathMetrics(candidate, bounds);
      const score = pathScore(candidate, metrics);
      if (score < bestAnyScore) {
        bestAny = candidate;
        bestAnyScore = score;
      }
      if (metrics.staysInBounds && score < bestInBoundsScore) {
        bestInBounds = candidate;
        bestInBoundsScore = score;
      }
    }
    return bestInBounds ?? bestAny;
  };
  const pathSpring = (path) => {
    const metrics = pathMetrics(path);
    const directDistance = Math.max(1, distance(path.start, path.end));
    const detour = Math.max(0, metrics.length / directDistance - 1);
    const distanceFactor = clamp((metrics.length - 180) / 760, 0, 1);
    const detourFactor = clamp(detour / 0.55, 0, 1);
    const turnFactor = clamp(metrics.totalTurn / (Math.PI * 1.4), 0, 1);
    const energyFactor = clamp(metrics.angleChangeEnergy / 1.25, 0, 1);
    const complexity = clamp(
      detourFactor * 0.42 + turnFactor * 0.38 + energyFactor * 0.2,
      0,
      1,
    );
    const response = clamp(
      (0.42 +
        distanceFactor * 0.22 +
        complexity * 0.12 +
        directionalPenalty(path) * 0.28 +
        (path.arc == null ? 0 : 0.04)) *
        0.7 *
        (path.arc == null ? 1 : 0.9),
      0.12,
      2.2,
    );
    return { dampingFraction: 0.9, response };
  };

  const makeSpring = (value, target, config) => ({
    dampingFraction: config.dampingFraction,
    force: 0,
    response: config.response,
    scriptTime: 0,
    simulationTime: 0,
    target,
    value,
    velocity: 0,
  });
  const forceSpring = (spring, value) => {
    spring.force = 0;
    spring.scriptTime = 0;
    spring.simulationTime = 0;
    spring.target = value;
    spring.value = value;
    spring.velocity = 0;
  };
  const springSettled = (spring) => {
    if (
      Math.max(spring.velocity * spring.velocity, spring.force * spring.force) >
      SETTLE_THRESHOLD * SETTLE_THRESHOLD
    ) {
      return false;
    }
    const relativeThreshold = spring.target * 0.01;
    const remaining = spring.target - spring.value;
    return (
      relativeThreshold === 0 ||
      remaining * remaining <= relativeThreshold * relativeThreshold
    );
  };
  const advanceSpring = (spring, elapsedSeconds) => {
    const response = Math.max(0.001, spring.response);
    const stiffness = Math.min(
      (Math.PI * 2) ** 2 / response ** 2,
      1 / (2 * SPRING_STEP ** 2),
    );
    const damping = Math.sqrt(stiffness) * 2 * spring.dampingFraction;
    spring.scriptTime += Math.max(0, elapsedSeconds);
    if (spring.scriptTime - spring.simulationTime > MAX_CATCH_UP_SECONDS) {
      spring.simulationTime = spring.scriptTime - FRAME_SECONDS;
    }
    while (spring.simulationTime < spring.scriptTime) {
      const halfStep = SPRING_STEP / 2;
      const midpointVelocity = spring.velocity + spring.force * halfStep;
      spring.value += midpointVelocity * SPRING_STEP;
      spring.force =
        midpointVelocity * -damping +
        (spring.target - spring.value) * stiffness;
      spring.velocity = midpointVelocity + spring.force * halfStep;
      spring.simulationTime += SPRING_STEP;
    }
    if (springSettled(spring)) spring.value = spring.target;
  };
  const targetAngle = (spring, degrees) => {
    spring.target = spring.value + shortestDegreeDelta(spring.value, degrees);
  };
  const setPositionSpringConfig = (state, response, dampingFraction) => {
    state.positionXSpring.response = response;
    state.positionYSpring.response = response;
    state.positionXSpring.dampingFraction = dampingFraction;
    state.positionYSpring.dampingFraction = dampingFraction;
  };
  const resetScoot = (state) => {
    forceSpring(state.scootAxisSpring, 0);
    forceSpring(state.scootRotationSpring, 0);
    forceSpring(state.scootStretchSpring, 1);
    state.scootAxisRotation = 0;
  };
  const forcePoint = (state, point) => {
    state.point = point;
    forceSpring(state.positionXSpring, point.x);
    forceSpring(state.positionYSpring, point.y);
  };
  const forceStatePoint = (state, point) => {
    state.motion = null;
    forcePoint(state, point);
    forceSpring(state.rotationSpring, normalizeDegrees(CLICK_ANGLE));
    state.rotation = state.rotationSpring.value;
    resetScoot(state);
    forceSpring(state.stretchSpring, 1);
  };
  const createState = (point) => {
    const rotation = normalizeDegrees(CLICK_ANGLE);
    return {
      motion: null,
      point,
      positionXSpring: makeSpring(point.x, point.x, SPRINGS.position),
      positionYSpring: makeSpring(point.y, point.y, SPRINGS.position),
      rotation,
      rotationSpring: makeSpring(rotation, rotation, SPRINGS.rotation),
      scootAxisRotation: 0,
      scootAxisSpring: makeSpring(0, 0, SPRINGS.rotation),
      scootRotationSpring: makeSpring(0, 0, SPRINGS.scootRotation),
      scootStretchSpring: makeSpring(1, 1, SPRINGS.scootStretch),
      stretchSpring: makeSpring(1, 1, SPRINGS.stretch),
      thinkStartedAt: null,
      visibilitySpring: makeSpring(0, 0, SPRINGS.visibility),
    };
  };
  const cursorArrived = (state, point) =>
    distance(state.point, point) <= ARRIVAL_DISTANCE &&
    Math.abs(state.positionXSpring.velocity) <= ARRIVAL_VELOCITY &&
    Math.abs(state.positionYSpring.velocity) <= ARRIVAL_VELOCITY;
  const advancePosition = (state, elapsedSeconds) => {
    const previous = state.point;
    advanceSpring(state.positionXSpring, elapsedSeconds);
    advanceSpring(state.positionYSpring, elapsedSeconds);
    advanceSpring(state.rotationSpring, elapsedSeconds);
    advanceSpring(state.scootAxisSpring, elapsedSeconds);
    const next = {
      x: state.positionXSpring.value,
      y: state.positionYSpring.value,
    };
    const speed =
      distance(previous, next) / Math.max(elapsedSeconds, SPRING_STEP);
    state.point = next;
    state.rotation = state.rotationSpring.value;
    state.scootAxisRotation = state.scootAxisSpring.value;
    return speed;
  };
  const projectedProgress = (point, start, end) => {
    const delta = { x: end.x - start.x, y: end.y - start.y };
    const lengthSquared = delta.x * delta.x + delta.y * delta.y;
    if (lengthSquared < 0.001) return 1;
    return clamp(
      ((point.x - start.x) * delta.x + (point.y - start.y) * delta.y) /
        lengthSquared,
      0,
      1,
    );
  };
  const beginMotion = (state, target, viewport) => {
    state.thinkStartedAt = null;
    const start = { ...state.point };
    if (distance(start, target) <= SMALL_MOVE_DISTANCE) {
      const unit = normalize({ x: target.x - start.x, y: target.y - start.y });
      const axisRotation =
        distance({ x: 0, y: 0 }, unit) < 0.001
          ? 0
          : Math.atan2(unit.y, unit.x) * (180 / Math.PI);
      const rotationTarget =
        clamp(unit.x * 0.75 + -unit.y * 0.62, -1, 1) * SCOOT_ROTATION;
      setPositionSpringConfig(
        state,
        SPRINGS.position.response,
        SPRINGS.position.dampingFraction,
      );
      state.positionXSpring.target = target.x;
      state.positionYSpring.target = target.y;
      targetAngle(state.rotationSpring, normalizeDegrees(CLICK_ANGLE));
      targetAngle(state.scootAxisSpring, axisRotation);
      state.motion = {
        axisRotation,
        end: target,
        mode: "scoot",
        progressSpring: makeSpring(0, 1, SPRINGS.scootProgress),
        rotationTarget,
        start,
      };
      return;
    }
    const path = choosePath(viewport, start, target);
    const spring = pathSpring(path);
    const positionResponse = clamp(spring.response * 0.18, 0.035, 0.12);
    setPositionSpringConfig(state, positionResponse, spring.dampingFraction);
    state.motion = {
      mode: "bezier",
      path,
      progressSpring: makeSpring(0, 1, spring),
    };
  };
  const advanceMotion = (state, elapsedSeconds, timestamp) => {
    if (state.motion == null) {
      state.stretchSpring.target = 1;
      state.scootStretchSpring.target = 1;
      state.scootRotationSpring.target = 0;
      return false;
    }
    state.thinkStartedAt = null;
    const motion = state.motion;
    advanceSpring(motion.progressSpring, elapsedSeconds);
    if (motion.mode === "bezier") {
      state.scootStretchSpring.target = 1;
      state.scootRotationSpring.target = 0;
      const progress = clamp(motion.progressSpring.value, 0, 1);
      const sample = pointOnPath(motion.path, progress);
      state.positionXSpring.target = sample.point.x;
      state.positionYSpring.target = sample.point.y;
      targetAngle(state.rotationSpring, tangentRotation(sample.tangent));
      targetAngle(state.scootAxisSpring, 0);
      const speed = advancePosition(state, elapsedSeconds);
      state.stretchSpring.target = clamp(1 - speed / 5_500, 0.65, 1);
      if (
        progress >= 0.999 &&
        Math.abs(motion.progressSpring.velocity) < 0.01 &&
        cursorArrived(state, sample.point)
      ) {
        const end = pointOnPath(motion.path, 1);
        forcePoint(state, end.point);
        forceSpring(state.rotationSpring, tangentRotation(end.tangent));
        state.rotation = state.rotationSpring.value;
        forceSpring(state.scootAxisSpring, 0);
        state.scootAxisRotation = 0;
        forceSpring(state.stretchSpring, 1);
        state.motion = null;
        state.thinkStartedAt = timestamp;
        return true;
      }
      return false;
    }
    state.positionXSpring.target = motion.end.x;
    state.positionYSpring.target = motion.end.y;
    targetAngle(state.scootAxisSpring, motion.axisRotation);
    targetAngle(state.rotationSpring, normalizeDegrees(CLICK_ANGLE));
    advancePosition(state, elapsedSeconds);
    const progress = projectedProgress(state.point, motion.start, motion.end);
    const envelope = Math.sin(Math.min(1, progress) * Math.PI);
    state.stretchSpring.target = 1;
    state.scootStretchSpring.target = mix(
      1,
      mix(1, 0, Math.sin(clamp(progress, 0, 1) * Math.PI)),
      0.15,
    );
    state.scootRotationSpring.target = motion.rotationTarget * envelope;
    if (
      progress >= 0.999 &&
      Math.abs(motion.progressSpring.velocity) < 0.01 &&
      cursorArrived(state, motion.end)
    ) {
      forcePoint(state, motion.end);
      forceSpring(state.rotationSpring, normalizeDegrees(CLICK_ANGLE));
      state.rotation = state.rotationSpring.value;
      resetScoot(state);
      forceSpring(state.stretchSpring, 1);
      state.motion = null;
      state.thinkStartedAt = timestamp;
      return true;
    }
    return false;
  };
  const stateAnimating = (state) =>
    state.motion != null ||
    state.thinkStartedAt != null ||
    !springSettled(state.positionXSpring) ||
    !springSettled(state.positionYSpring) ||
    !springSettled(state.rotationSpring) ||
    !springSettled(state.scootAxisSpring) ||
    !springSettled(state.scootRotationSpring) ||
    !springSettled(state.scootStretchSpring) ||
    !springSettled(state.stretchSpring) ||
    !springSettled(state.visibilitySpring);

  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "all:initial;position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:2147483646;contain:strict;display:block;";
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "closed" });
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText =
    "position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:2147483646;";
  const cursor = document.createElement("div");
  cursor.dataset.testid = "browser-agent-cursor";
  cursor.style.cssText =
    "position:absolute;left:0;top:0;width:24px;height:24px;transform-origin:12px 12px;will-change:transform,opacity,filter;";
  const imageOffset = document.createElement("div");
  imageOffset.style.transform = `translate3d(${IMAGE_X}px,${IMAGE_Y}px,0)`;
  const image = document.createElement("img");
  image.alt = "";
  image.draggable = false;
  image.width = IMAGE_WIDTH;
  image.height = IMAGE_HEIGHT;
  image.src = assetUrl;
  image.style.cssText =
    `display:block;transform:rotate(${IMAGE_ROTATION}deg) scale(1);transform-origin:0 0;` +
    `--browser-agent-cursor-glow-color:${glowColor};` +
    "filter:drop-shadow(0 0 6px color-mix(in srgb,var(--browser-agent-cursor-glow-color) 90%,transparent)) drop-shadow(0 0 15px color-mix(in srgb,var(--browser-agent-cursor-glow-color) 48%,transparent));";
  imageOffset.appendChild(image);
  cursor.appendChild(imageOffset);
  layer.appendChild(cursor);
  shadow.replaceChildren(layer);

  let state = createState({
    x: Math.round(window.innerWidth * 0.58),
    y: Math.round(window.innerHeight * 0.55),
  });
  let frame = null;
  let previousFrameTime = now();
  let firstMovementFrame = false;
  let destroyed = false;
  let activeArrivalKey = null;
  let deliveredArrivalKey = null;
  const arrivalWaiters = new Map();
  const observer = new MutationObserver(() => {
    if (!host.isConnected) {
      (document.documentElement || document.body).appendChild(host);
    }
  });
  observer.observe(document, { childList: true, subtree: true });

  const render = () => {
    let rotation = state.rotation;
    if (state.thinkStartedAt != null) {
      const elapsed = (now() - state.thinkStartedAt) / 1_000;
      const progress = Math.min(1, elapsed / THINK_DURATION_SECONDS);
      const envelope = Math.sin(progress * Math.PI);
      const oscillation =
        Math.sin((elapsed / THINK_PERIOD_SECONDS) * Math.PI * 2) * envelope;
      if (progress >= 1) state.thinkStartedAt = null;
      else rotation += oscillation * THINK_AMPLITUDE_DEGREES;
    }
    const visibility = clamp(state.visibilitySpring.value, 0, 1);
    const visibilityScale = mix(0.4, 1, visibility);
    const blur = mix(5, 0, visibility);
    const scootStretch = clamp(state.scootStretchSpring.value, 0, 1);
    const transforms = [
      `translate3d(${round(state.point.x - CENTER)}px,${round(state.point.y - CENTER)}px,0)`,
    ];
    if (
      Math.abs(shortestDegreeDelta(0, state.scootAxisRotation)) > 0.001 ||
      Math.abs(scootStretch - 1) > 0.001
    ) {
      transforms.push(
        `rotate(${round(state.scootAxisRotation)}deg)`,
        `scale(1,${round(scootStretch)})`,
        `rotate(${round(-state.scootAxisRotation)}deg)`,
      );
    }
    transforms.push(
      `rotate(${round(normalizeDegrees(rotation + state.scootRotationSpring.value))}deg)`,
      `scale(${round(state.stretchSpring.value * visibilityScale)},${round(visibilityScale)})`,
    );
    cursor.style.transform = transforms.join(" ");
    cursor.style.opacity = String(round(visibility));
    cursor.style.filter = `blur(${round(blur)}px)`;
  };
  const deliverArrival = () => {
    if (activeArrivalKey == null || deliveredArrivalKey === activeArrivalKey)
      return;
    deliveredArrivalKey = activeArrivalKey;
    const waiter = arrivalWaiters.get(activeArrivalKey);
    if (waiter != null) {
      arrivalWaiters.delete(activeArrivalKey);
      waiter(true);
    }
  };
  const animateFrame = (timestamp) => {
    frame = null;
    if (destroyed) return;
    const elapsedSeconds = firstMovementFrame
      ? FRAME_SECONDS
      : Math.max(FRAME_SECONDS, (timestamp - previousFrameTime) / 1_000);
    firstMovementFrame = false;
    previousFrameTime = timestamp;
    const arrived = advanceMotion(state, elapsedSeconds, timestamp);
    advanceSpring(state.visibilitySpring, elapsedSeconds);
    advanceSpring(state.stretchSpring, elapsedSeconds);
    advanceSpring(state.scootStretchSpring, elapsedSeconds);
    advanceSpring(state.scootRotationSpring, elapsedSeconds);
    render();
    if (arrived) deliverArrival();
    if (stateAnimating(state)) scheduleFrame();
  };
  const scheduleFrame = () => {
    if (frame != null || destroyed) return;
    frame = window.requestAnimationFrame(animateFrame);
  };
  const clampTarget = (value, viewport) => ({
    x: clamp(value.x, 0, viewport.width),
    y: clamp(value.y, 0, viewport.height),
  });

  const controller = {
    destroy() {
      destroyed = true;
      if (frame != null) window.cancelAnimationFrame(frame);
      observer.disconnect();
      for (const waiter of arrivalWaiters.values()) waiter(false);
      arrivalWaiters.clear();
      host.remove();
    },
    setState(next) {
      const viewport = {
        width: Math.max(
          1,
          Number(next.viewportSize?.width) || window.innerWidth,
        ),
        height: Math.max(
          1,
          Number(next.viewportSize?.height) || window.innerHeight,
        ),
      };
      const target = clampTarget(
        {
          x: Number(next.cursor?.x),
          y: Number(next.cursor?.y),
        },
        viewport,
      );
      const visible =
        next.isVisible !== false && next.cursor?.visible !== false;
      state.visibilitySpring.target = visible ? 1 : 0;
      if (!visible || next.cursor == null) {
        state.motion = null;
        render();
        scheduleFrame();
        return Promise.resolve(true);
      }

      const moveSequence = Number.isInteger(next.cursor.moveSequence)
        ? next.cursor.moveSequence
        : 0;
      activeArrivalKey = `${next.turnKey ?? ""}:${moveSequence}`;
      const arrivalKey = activeArrivalKey;
      const arrival = new Promise((resolve) => {
        arrivalWaiters.set(arrivalKey, resolve);
        window.setTimeout(() => {
          const waiter = arrivalWaiters.get(arrivalKey);
          if (waiter == null) return;
          arrivalWaiters.delete(arrivalKey);
          waiter(false);
        }, 4_000);
      });
      const shouldAnimate = next.cursor.animateMovement !== false;
      const remainingDistance = distance(state.point, target);
      if (
        !shouldAnimate ||
        state.visibilitySpring.value <= 0.001 ||
        remainingDistance < 0.5
      ) {
        if (state.visibilitySpring.value <= 0.001) {
          forceSpring(state.visibilitySpring, 1);
        }
        forceStatePoint(state, target);
        if (!shouldAnimate) {
          state.stretchSpring.force = 0;
          state.stretchSpring.value = 1;
          state.stretchSpring.velocity = 0;
        }
        state.thinkStartedAt = now();
        render();
        deliverArrival();
        scheduleFrame();
        return arrival;
      }
      beginMotion(state, target, viewport);
      firstMovementFrame = true;
      render();
      scheduleFrame();
      return arrival;
    },
  };
  render();
  return controller;
}

let moveSequence = 0;
const cursorTabsByOwner = new Map();

const buildControllerExpression = (payload) => `(() => {
  const rootId = ${JSON.stringify(ROOT_ID)};
  const controllerProperty = ${JSON.stringify(CONTROLLER_PROPERTY)};
  let host = document.getElementById(rootId);
  let controller = host?.[controllerProperty];
  if (!controller) {
    host?.remove();
    host = document.createElement('div');
    host.id = rootId;
    (document.documentElement || document.body).appendChild(host);
    controller = (${installAgentCursor.toString()})(
      host,
      ${JSON.stringify(CURSOR_ASSET)},
      ${JSON.stringify(DEFAULT_GLOW_COLOR)}
    );
    Object.defineProperty(host, controllerProperty, {
      configurable: false,
      enumerable: false,
      value: controller,
      writable: false,
    });
  }
  return controller.setState(${JSON.stringify(payload)});
})()`;

export const buildAgentCursorPresentationExpression = ({
  x,
  y,
  animateMovement = true,
  moveSequence: requestedSequence = undefined,
  turnKey = "browser",
}) =>
  buildControllerExpression({
    cursor: {
      animateMovement,
      moveSequence: requestedSequence ?? ++moveSequence,
      visible: true,
      x,
      y,
    },
    isVisible: true,
    turnKey,
    viewportSize: { height: 0, width: 0 },
  });

export const buildAgentCursorHideExpression = ({ turnKey = "browser" } = {}) =>
  `(() => {
    const host = document.getElementById(${JSON.stringify(ROOT_ID)});
    const controller = host?.[${JSON.stringify(CONTROLLER_PROPERTY)}];
    if (!controller) return true;
    return controller.setState({ cursor: null, isVisible: false, turnKey: ${JSON.stringify(turnKey)}, viewportSize: { height: window.innerHeight, width: window.innerWidth } });
  })()`;

export const trackAgentCursorTab = (ownerId, tabId) => {
  const key = typeof ownerId === "string" && ownerId ? ownerId : "default";
  let tabIds = cursorTabsByOwner.get(key);
  if (tabIds == null) {
    tabIds = new Set();
    cursorTabsByOwner.set(key, tabIds);
  }
  tabIds.add(tabId);
};

export const takeAgentCursorTabs = (ownerId) => {
  const key = typeof ownerId === "string" && ownerId ? ownerId : "default";
  const tabIds = [...(cursorTabsByOwner.get(key) ?? [])];
  cursorTabsByOwner.delete(key);
  return tabIds;
};
