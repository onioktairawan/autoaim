(() => {
  // 1. CLEANUP INSTANCE LAMA
  const oldHud = document.getElementById('aim-hud-pc');
  if (oldHud) oldHud.remove();

  window._autoAimV16Master = true;

  let lastHitData = null;
  let canvasW = 640;
  let canvasH = 1100;
  let internalBalls = [];
  let currentCue = null;
  let currentShotIndex = 0;
  let cachedShots = [];
  let hudVisible = true;
  let targetMode = 'AUTO'; // 'AUTO' | 'ALL' | 'CARD' | 'TRICK'
  let simulatedLandingCue = null;

  const canvasEl = document.getElementById('tableCanvas') || document.querySelector('canvas');

  // 2. KONSTANTA RESMI FISIKA ENGINE
  const ENGINE_TABLE = {
    railInset: 0.045,
    ballRadius: 0.0234,
    pocketRadius: 0.032,
    pocketInset: 0.02,
    restitution: 0.82
  };

  // 3. DETEKSI KARTU AKTIF
  function getMyCardNumbers() {
    let rawCards = [];

    if (typeof myCards !== 'undefined' && Array.isArray(myCards) && myCards.length > 0) {
      rawCards = myCards.filter(c => !c.pocketed).map(c => c.ball_num);
    } else {
      const cardsRow = document.getElementById('game-mode-banner-row');
      if (cardsRow) {
        const cardEls = cardsRow.querySelectorAll('.ball-card:not(.cleared)');
        cardEls.forEach(el => {
          const numEl = el.querySelector('.ball-card-num');
          if (numEl && numEl.textContent) {
            const val = parseInt(numEl.textContent.trim(), 10);
            if (!isNaN(val)) rawCards.push(val);
          }
        });
      }
    }

    const activeTableBalls = (typeof balls !== 'undefined' ? balls : internalBalls);
    if (activeTableBalls && activeTableBalls.length > 0) {
      return rawCards.filter(num => {
        const b = activeTableBalls.find(x => x.num === num);
        return b && !b.pocketed;
      });
    }

    return rawCards;
  }

  function isCardModeActive() {
    if (targetMode === 'CARD') return true;
    if (targetMode === 'ALL' || targetMode === 'TRICK') return false;
    if (typeof gameMode !== 'undefined' && gameMode === 'random_assign') return true;
    const cards = getMyCardNumbers();
    return cards !== null && cards.length > 0;
  }

  // 4. HOOK FISIKA ENGINE
  const originalFind = window.findTargetBall;
  if (typeof originalFind === 'function') {
    window.findTargetBall = function(cue, w, h, angle) {
      canvasW = w || (canvasEl ? canvasEl.width : 640);
      canvasH = h || (canvasEl ? canvasEl.height : 1100);
      if (cue) currentCue = cue;
      const hit = originalFind.apply(this, arguments);
      lastHitData = hit || null;
      return hit;
    };
  }

  if (typeof window.drawBalls === 'function') {
    const origDrawBalls = window.drawBalls;
    window.drawBalls = function(w, h) {
      canvasW = w;
      canvasH = h;
      if (typeof balls !== 'undefined' && Array.isArray(balls)) {
        internalBalls = balls;
      }
      return origDrawBalls.apply(this, arguments);
    };
  }

  // 5. KOORDINAT LUBANG
  function getPockets() {
    if (typeof window.getPocketPositions === 'function') {
      try {
        const raw = window.getPocketPositions(canvasW, canvasH);
        if (raw && raw.length === 6) {
          const names = ['Top-Left', 'Top-Right', 'Mid-Left', 'Mid-Right', 'Bot-Left', 'Bot-Right'];
          return raw.map((p, idx) => ({
            id: names[idx],
            isSide: idx === 2 || idx === 3,
            sideDir: idx === 2 ? -1 : (idx === 3 ? 1 : 0),
            x: p.x,
            y: p.y,
            r: p.r
          }));
        }
      } catch(e) {}
    }

    const railW = canvasW * ENGINE_TABLE.railInset;
    const inset = canvasW * ENGINE_TABLE.pocketInset;
    const r = canvasW * ENGINE_TABLE.pocketRadius;
    const midOut = canvasW * 0.025;

    return [
      { id: 'Top-Left',  isSide: false, x: railW + inset, y: railW + inset, r: r },
      { id: 'Top-Right', isSide: false, x: canvasW - railW - inset, y: railW + inset, r: r },
      { id: 'Mid-Left',  isSide: true,  sideDir: -1, x: railW + inset - midOut, y: canvasH / 2, r: r },
      { id: 'Mid-Right', isSide: true,  sideDir: 1,  x: canvasW - railW - inset + midOut, y: canvasH / 2, r: r },
      { id: 'Bot-Left',  isSide: false, x: railW + inset, y: canvasH - railW - inset, r: r },
      { id: 'Bot-Right', isSide: false, x: canvasW - railW - inset, y: canvasH - railW - inset, r: r }
    ];
  }

  function getBallRadius() {
    return canvasW * ENGINE_TABLE.ballRadius;
  }

  // 6. DETEKTOR HALANGAN CAPSULE
  function isPathBlocked(x1, y1, x2, y2, ignoredNums, allBalls, radius) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return false;

    const dirX = dx / dist;
    const dirY = dy / dist;
    const safeRadius = radius * 2.05;

    for (let i = 0; i < allBalls.length; i++) {
      const b = allBalls[i];
      if (ignoredNums.includes(b.num) || b.pocketed) continue;

      const bx = b.x * canvasW;
      const by = b.y * canvasH;
      const ox = bx - x1;
      const oy = by - y1;

      const proj = ox * dirX + oy * dirY;

      if (proj > radius * 0.9 && proj < dist - radius * 0.9) {
        const perpDist = Math.hypot(ox - dirX * proj, oy - dirY * proj);
        if (perpDist < safeRadius) {
          return true;
        }
      }
    }
    return false;
  }

  // 7. HIGH-PERFORMANCE VIRTUAL SANDBOX (DEEP MULTI-RAIL ADAPTIVE)
  function simulateVirtualShot(angle, power, targetBallNum, customMaxFrames) {
    if (targetBallNum === undefined) targetBallNum = null;
    if (customMaxFrames === undefined) customMaxFrames = 150;

    const activeBalls = typeof balls !== 'undefined' ? balls : internalBalls;
    const cue = activeBalls.find(b => b.num === 0 && !b.pocketed);
    if (!cue) return { cuePocketed: false, targetPocketed: false, pocketedCount: 0, pocketedList: [], isDoubleKiss: false, finalCuePos: null, cueCushionHits: 0, firstHitBall: null, hitChain: [] };

    const w = canvasW, h = canvasH;
    const railW = w * ENGINE_TABLE.railInset;
    const r = w * ENGINE_TABLE.ballRadius;
    const pockets = getPockets();
    const friction = typeof FRICTION !== 'undefined' ? FRICTION : 0.985;
    const maxPowerSpeed = typeof MAX_POWER_SPEED !== 'undefined' ? MAX_POWER_SPEED : 1.8;
    const minVelPx = (typeof MIN_VELOCITY !== 'undefined' ? MIN_VELOCITY : 0.001) * w;
    const collisionVelThresh = (typeof COLLISION_VEL_THRESHOLD_FACTOR !== 'undefined' ? COLLISION_VEL_THRESHOLD_FACTOR : 0.0005) * w;

    const vBalls = [];
    for (let i = 0; i < activeBalls.length; i++) {
      const b = activeBalls[i];
      if (!b.pocketed) {
        vBalls.push({ num: b.num, x: b.x, y: b.y, vx: 0, vy: 0, pocketed: false });
      }
    }

    const vCue = vBalls.find(b => b.num === 0);
    if (!vCue) return { cuePocketed: false, targetPocketed: false, pocketedCount: 0, pocketedList: [], isDoubleKiss: false, finalCuePos: null, cueCushionHits: 0, firstHitBall: null, hitChain: [] };

    const speed = (power / 100) * maxPowerSpeed * w;
    vCue.vx = Math.cos(angle) * speed;
    vCue.vy = Math.sin(angle) * speed;

    let cuePocketed = false;
    let targetPocketed = false;
    let pocketedCount = 0;
    const pocketedList = [];
    let cueHitTargetCount = 0;
    let cueCushionHits = 0;
    let firstHitBall = null;
    const hitChain = [];

    const SUBSTEPS = 4;
    const MAX_FRAMES = customMaxFrames;

    for (let frame = 0; frame < MAX_FRAMES; frame++) {
      for (let s = 0; s < SUBSTEPS; s++) {
        for (let i = 0; i < vBalls.length; i++) {
          const b = vBalls[i];
          if (b.pocketed) continue;
          b.x += (b.vx / SUBSTEPS) / w;
          b.y += (b.vy / SUBSTEPS) / h;
        }

        // Pantulan Dinding
        for (let i = 0; i < vBalls.length; i++) {
          const b = vBalls[i];
          if (b.pocketed) continue;
          const bx = b.x * w, by = b.y * h;
          const minX = railW + r, maxX = w - railW - r;
          const minY = railW + r, maxY = h - railW - r;

          let bounced = false;
          if (bx < minX) { b.x = minX / w; if (b.vx < -collisionVelThresh) { b.vx *= -0.82; bounced = true; } else b.vx = 0; }
          if (bx > maxX) { b.x = maxX / w; if (b.vx > collisionVelThresh) { b.vx *= -0.82; bounced = true; } else b.vx = 0; }
          if (by < minY) { b.y = minY / h; if (b.vy < -collisionVelThresh) { b.vy *= -0.82; bounced = true; } else b.vy = 0; }
          if (by > maxY) { b.y = maxY / h; if (b.vy > collisionVelThresh) { b.vy *= -0.82; bounced = true; } else b.vy = 0; }

          if (bounced && b.num === 0 && firstHitBall === null) {
            cueCushionHits++;
          }
        }

        // Tabrakan Bola
        for (let i = 0; i < vBalls.length; i++) {
          for (let j = i + 1; j < vBalls.length; j++) {
            const a = vBalls[i], b = vBalls[j];
            if (a.pocketed || b.pocketed) continue;
            const dx = (b.x - a.x) * w, dy = (b.y - a.y) * h;
            const dist = Math.hypot(dx, dy);
            if (dist < r * 2 && dist > 0) {
              const nx = dx / dist, ny = dy / dist;
              const overlap = r * 2 - dist;
              a.x -= (nx * overlap / 2) / w; a.y -= (ny * overlap / 2) / h;
              b.x += (nx * overlap / 2) / w; b.y += (ny * overlap / 2) / h;

              const relVel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
              if (relVel < -collisionVelThresh) {
                if (a.num === 0 || b.num === 0) {
                  const otherBall = a.num === 0 ? b.num : a.num;
                  if (firstHitBall === null) firstHitBall = otherBall;
                  if (targetBallNum && otherBall === targetBallNum) cueHitTargetCount++;
                }

                const pairKey = Math.min(a.num, b.num) + '->' + Math.max(a.num, b.num);
                if (!hitChain.includes(pairKey)) hitChain.push(pairKey);

                const aDot = a.vx * nx + a.vy * ny;
                const bDot = b.vx * nx + b.vy * ny;
                a.vx += (bDot - aDot) * nx; a.vy += (bDot - aDot) * ny;
                b.vx += (aDot - bDot) * nx; b.vy += (aDot - bDot) * ny;
              }
            }
          }
        }

        // Masuk Lubang
        for (let i = 0; i < vBalls.length; i++) {
          const b = vBalls[i];
          if (b.pocketed) continue;
          const bx = b.x * w, by = b.y * h;
          for (let pIdx = 0; pIdx < pockets.length; pIdx++) {
            const p = pockets[pIdx];
            if (Math.hypot(bx - p.x, by - p.y) < p.r * 0.92) {
              b.pocketed = true;
              b.vx = 0; b.vy = 0;
              if (b.num === 0) cuePocketed = true;
              else {
                pocketedCount++;
                pocketedList.push({ num: b.num, pocket: p });
                if (targetBallNum && b.num === targetBallNum) targetPocketed = true;
              }
              break;
            }
          }
        }
      }

      let isMoving = false;
      for (let i = 0; i < vBalls.length; i++) {
        const b = vBalls[i];
        if (b.pocketed) continue;
        b.vx *= friction;
        b.vy *= friction;
        if (Math.hypot(b.vx, b.vy) < minVelPx) { b.vx = 0; b.vy = 0; }
        else isMoving = true;
      }

      if (!isMoving || cuePocketed) break;
    }

    return {
      cuePocketed: cuePocketed,
      targetPocketed: targetPocketed,
      pocketedCount: pocketedCount,
      pocketedList: pocketedList,
      isDoubleKiss: cueHitTargetCount > 1,
      finalCuePos: { x: vCue.x * w, y: vCue.y * h },
      cueCushionHits: cueCushionHits,
      firstHitBall: firstHitBall,
      hitChain: hitChain
    };
  }

  // 8. FAST GOLDEN BREAK-SHOT SOLVER
  function solveGoldenBreakShot(cue, activeBalls, pockets) {
    const cueX = cue.x * canvasW;
    const cueY = cue.y * canvasH;

    const frontBalls = activeBalls
      .filter(b => b.num !== 0 && !b.pocketed && b.y < 0.42)
      .sort((a, b) => a.y - b.y)
      .slice(0, 3);

    if (frontBalls.length === 0) return null;

    const apexBall = frontBalls[0];
    const ax = apexBall.x * canvasW;
    const ay = apexBall.y * canvasH;
    const baseAngle = Math.atan2(ay - cueY, ax - cueX);

    const testOffsets = [
      0.024, -0.024, 0.038, -0.038, 0.052, -0.052, 0.068, -0.068, 
      0.085, -0.085, 0.105, -0.105, 0.125, -0.125, 0.012, -0.012
    ];

    let bestBreak = null;
    let maxPockets = 0;

    for (let i = 0; i < testOffsets.length; i++) {
      const offset = testOffsets[i];
      const testAngle = baseAngle + offset;
      const testPower = 100;
      const vResult = simulateVirtualShot(testAngle, testPower, apexBall.num, 170);

      if (!vResult.cuePocketed) {
        if (vResult.pocketedCount > maxPockets) {
          maxPockets = vResult.pocketedCount;
          bestBreak = {
            angle: testAngle,
            power: testPower,
            pocketedCount: vResult.pocketedCount,
            landingCue: vResult.finalCuePos
          };
        }
      }
    }

    const finalBreakAngle = bestBreak ? bestBreak.angle : (baseAngle + 0.038);
    const finalBreakPower = 100;

    return {
      ball: apexBall,
      ballNum: apexBall.num,
      isBreak: true,
      isCard: false,
      isBank: false,
      isKick: false,
      isTrick: false,
      trickTag: 'BREAK',
      pocketName: '⚡BREAK',
      pocket: pockets[0],
      angle: finalBreakAngle,
      power: finalBreakPower,
      cutQuality: '100%',
      difficulty: -300,
      landingCue: bestBreak ? bestBreak.landingCue : null,
      ghostX: ax,
      ghostY: ay,
      targetX: ax,
      targetY: ay,
      pocketX: pockets[0].x,
      pocketY: pockets[0].y
    };
  }

  function checkBreakShotCondition(activeBalls, cue) {
    const unpocketed = activeBalls.filter(b => b.num !== 0 && !b.pocketed);
    if (unpocketed.length < 14) return false;
    if (!cue || cue.y < 0.72) return false;

    const xs = unpocketed.map(b => b.x);
    const ys = unpocketed.map(b => b.y);
    const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);

    const rackWidth = maxX - minX;
    const rackHeight = maxY - minY;

    return (rackWidth < 0.24 && rackHeight < 0.24 && minY > 0.15 && maxY < 0.45);
  }

  // 9. 👑 DEEP SANDBOX TRICKSHOT SOLVER (UP TO 6-RAIL GOD SHOT & MULTI-POT)
  function solveAllTrickshots() {
    const cue = (typeof balls !== 'undefined' ? balls.find(b => b.num === 0 && !b.pocketed) : null) || currentCue;
    if (!cue) return [];

    const activeBalls = (typeof balls !== 'undefined' ? balls : internalBalls).filter(b => b.num !== 0 && !b.pocketed);
    if (activeBalls.length === 0) return [];

    const cardNums = getMyCardNumbers();
    const inCardMode = isCardModeActive() && cardNums && cardNums.length > 0;
    const foundTricks = [];
    const testedAngles = [];

    // Prioritas Power 100% dan 95% untuk multi-rail ekstrim
    const testPowers = [100, 85, 95, 70];
    const angleSteps = 160; // 160 step pencarian lebih rapat

    for (let pIdx = 0; pIdx < testPowers.length; pIdx++) {
      const pwr = testPowers[pIdx];
      for (let i = 0; i < angleSteps; i++) {
        const testAngle = (i / angleSteps) * Math.PI * 2 - Math.PI;
        // Gunakan 240 frame agar pantulan 4-6 ban selesai sempurna
        const vResult = simulateVirtualShot(testAngle, pwr, null, 240);

        if (!vResult.cuePocketed && vResult.pocketedCount > 0 && vResult.firstHitBall !== null) {
          let potBalls = vResult.pocketedList;
          if (inCardMode) {
            const cardPots = potBalls.filter(item => cardNums.includes(item.num));
            if (cardPots.length === 0) continue;
            potBalls = cardPots;
          }

          if (!inCardMode && potBalls.length > 1) {
            potBalls.sort((a, b) => b.num - a.num);
          }

          const potItem = potBalls[0];
          const potBallObj = activeBalls.find(b => b.num === potItem.num);
          if (!potBallObj) continue;

          // Fine-Tuning Mikro Presisi 0.005 radian
          let bestAngle = testAngle;
          for (let fine = -0.025; fine <= 0.025; fine += 0.008) {
            const fineAngle = testAngle + fine;
            const fResult = simulateVirtualShot(fineAngle, pwr, potItem.num, 240);
            if (!fResult.cuePocketed && fResult.targetPocketed) {
              bestAngle = fineAngle;
              break;
            }
          }

          const isDuplicate = testedAngles.some(a => Math.abs(a - bestAngle) < 0.05);
          if (isDuplicate) continue;
          testedAngles.push(bestAngle);

          let trickTag = 'TRICK';
          let trickScore = 100;

          // Klasifikasi Multi-Rail 1-6 Ban & Multi-Pot
          if (vResult.pocketedCount >= 2) {
            const potNumList = vResult.pocketedList.map(x => '#' + x.num).join('+');
            trickTag = 'MULTI ' + potNumList;
            
            const myCardsInMulti = inCardMode ? vResult.pocketedList.filter(x => cardNums.includes(x.num)).length : 0;
            if (myCardsInMulti >= 2) {
              trickScore = -200; // Super Priority #1
            } else {
              trickScore = -100 - (potItem.num * 2);
            }
          } else if (vResult.cueCushionHits >= 6) {
            trickTag = '6-RAIL GOD';
            trickScore = 5;
          } else if (vResult.cueCushionHits === 5) {
            trickTag = '5-RAIL WORLD';
            trickScore = 10;
          } else if (vResult.cueCushionHits === 4) {
            trickTag = '4-RAIL';
            trickScore = 15;
          } else if (vResult.cueCushionHits === 3) {
            trickTag = '3-RAIL';
            trickScore = 20;
          } else if (vResult.cueCushionHits === 2) {
            trickTag = '2-RAIL';
            trickScore = 25;
          } else if (vResult.firstHitBall !== potItem.num) {
            trickTag = 'COMBO #' + vResult.firstHitBall + '->#' + potItem.num;
            trickScore = 18 - potItem.num;
          } else if (vResult.hitChain.length > 1) {
            trickTag = 'CAROM';
            trickScore = 28 - potItem.num;
          } else if (vResult.cueCushionHits === 1) {
            trickTag = '1-RAIL';
            trickScore = 32 - potItem.num;
          }

          const targetBx = potBallObj.x * canvasW;
          const targetBy = potBallObj.y * canvasH;

          foundTricks.push({
            ball: potBallObj,
            ballNum: potBallObj.num,
            isCard: inCardMode ? cardNums.includes(potBallObj.num) : false,
            isBank: false,
            isKick: vResult.cueCushionHits > 0,
            isTrick: true,
            trickTag: trickTag,
            pocketName: potItem.pocket.id,
            pocket: potItem.pocket,
            angle: bestAngle,
            power: pwr,
            cutQuality: '100%',
            difficulty: trickScore,
            landingCue: vResult.finalCuePos,
            ghostX: targetBx,
            ghostY: targetBy,
            targetX: targetBx,
            targetY: targetBy,
            pocketX: potItem.pocket.x,
            pocketY: potItem.pocket.y
          });
        }
      }
    }

    foundTricks.sort((a, b) => {
      if (!inCardMode && b.ballNum !== a.ballNum) {
        return b.ballNum - a.ballNum; // Nilai bola terbesar duluan
      }
      return a.difficulty - b.difficulty;
    });

    return foundTricks;
  }

  // 10. SOLVER UTAMA TEMBAKAN REGULER
  function solveBestShots() {
    if (targetMode === 'TRICK') {
      const tricks = solveAllTrickshots();
      if (tricks.length > 0) {
        cachedShots = tricks;
        return cachedShots;
      }
    }

    const cue = (typeof balls !== 'undefined' ? balls.find(b => b.num === 0 && !b.pocketed) : null) || currentCue;
    if (!cue) return [];

    const pockets = getPockets();
    const r = getBallRadius();
    const e = ENGINE_TABLE.restitution;
    const railW = canvasW * ENGINE_TABLE.railInset;
    const minX = railW + r;
    const maxX = canvasW - railW - r;
    const minY = railW + r;
    const maxY = canvasH - railW - r;

    let activeBalls = (typeof balls !== 'undefined' ? balls : internalBalls).filter(b => b.num !== 0 && !b.pocketed);

    if (checkBreakShotCondition(typeof balls !== 'undefined' ? balls : internalBalls, cue)) {
      const breakShot = solveGoldenBreakShot(cue, activeBalls, pockets);
      if (breakShot) {
        cachedShots = [breakShot];
        return cachedShots;
      }
    }

    const cardNums = getMyCardNumbers();
    const inCardMode = isCardModeActive() && cardNums && cardNums.length > 0;

    let targetBalls = activeBalls;
    if (inCardMode) {
      const filtered = activeBalls.filter(b => cardNums.includes(b.num));
      targetBalls = filtered.length > 0 ? filtered : activeBalls;
    } else {
      targetBalls = activeBalls.slice().sort((a, b) => b.num - a.num);
    }

    if (targetBalls.length === 0) return [];

    const directCandidates = [];
    const bankCandidates = [];
    const kickCandidates = [];
    const cueX = cue.x * canvasW;
    const cueY = cue.y * canvasH;

    const minCutThreshold = targetBalls.length <= 2 ? 0.08 : 0.22;

    const cushions = [
      { name: 'Top',    axis: 'y', val: minY },
      { name: 'Bottom', axis: 'y', val: maxY },
      { name: 'Left',   axis: 'x', val: minX },
      { name: 'Right',  axis: 'x', val: maxX }
    ];

    for (let bIdx = 0; bIdx < targetBalls.length; bIdx++) {
      const b = targetBalls[bIdx];
      let bx = b.x * canvasW;
      let by = b.y * canvasH;

      for (let pIdx = 0; pIdx < pockets.length; pIdx++) {
        const p = pockets[pIdx];
        let pdx = p.x - bx;
        let pdy = p.y - by;
        let pDist = Math.hypot(pdx, pdy);
        if (pDist === 0) continue;

        let pDirX = pdx / pDist;
        let pDirY = pdy / pDist;

        let isStraightToMid = false;
        if (p.isSide) {
          if ((p.sideDir === -1 && pDirX >= 0) || (p.sideDir === 1 && pDirX <= 0)) continue;
          if (Math.abs(pDirX) < 0.65) continue;
          if (Math.abs(pDirX) >= 0.80) isStraightToMid = true;
        }

        let standardGhostX = bx - (pDirX * r * 2);
        let standardGhostY = by - (pDirY * r * 2);

        // A. DIRECT SHOTS
        let cdx = standardGhostX - cueX;
        let cdy = standardGhostY - cueY;
        let cDist = Math.hypot(cdx, cdy);

        if (cDist > 0) {
          let cDirX = cdx / cDist;
          let cDirY = cdy / cDist;
          let cutAngle = (cDirX * pDirX) + (cDirY * pDirY);

          if (cutAngle > minCutThreshold) {
            let cutFactor = Math.sqrt(Math.max(0, 1 - cutAngle * cutAngle));
            let compDist = cutFactor * (r * 0.08);

            let perpX = -pDirY;
            let perpY = pDirX;
            if ((cDirX * perpX + cDirY * perpY) < 0) {
              perpX = -perpX;
              perpY = -perpY;
            }

            let ghostX = standardGhostX + perpX * compDist;
            let ghostY = standardGhostY + perpY * compDist;

            let adjCdx = ghostX - cueX;
            let adjCdy = ghostY - cueY;
            let finalAngle = Math.atan2(adjCdy, adjCdx);

            let recommendedPower = 46;
            if (p.isSide) {
              recommendedPower = 32;
            } else if (cutAngle < 0.65) {
              recommendedPower = Math.round(34 + cutAngle * 10);
            } else {
              recommendedPower = Math.min(62, Math.round(42 + (pDist / canvasH) * 18));
            }

            const isCuePathBlocked = isPathBlocked(cueX, cueY, ghostX, ghostY, [0, b.num], activeBalls, r);
            const isTargetPathBlocked = isPathBlocked(bx, by, p.x, p.y, [b.num], activeBalls, r);

            if (!isCuePathBlocked && !isTargetPathBlocked) {
              let diffScore = (1 - cutAngle) * 0.50 + (pDist / canvasH) * 0.35 + (cDist / canvasH) * 0.2;
              if (p.isSide && isStraightToMid) diffScore -= 0.30;

              directCandidates.push({
                ball: b,
                ballNum: b.num,
                isCard: cardNums ? cardNums.includes(b.num) : false,
                isBank: false,
                isKick: false,
                isTrick: false,
                pocketName: p.id,
                pocket: p,
                angle: finalAngle,
                power: recommendedPower,
                cutQuality: (cutAngle * 100).toFixed(0) + '%',
                difficulty: diffScore,
                ghostX: ghostX,
                ghostY: ghostY,
                targetX: bx,
                targetY: by,
                pocketX: p.x,
                pocketY: p.y
              });
            }
          }
        }

        // B. KICK SHOTS
        for (let cIdx = 0; cIdx < cushions.length; cIdx++) {
          const c = cushions[cIdx];
          let kickBouncePoint = null;

          if (c.axis === 'x') {
            let distCue = Math.abs(cueX - c.val);
            let distG = Math.abs(standardGhostX - c.val);
            let isMovingTowardRail = (c.val === minX && cueX > minX && standardGhostX > minX) || (c.val === maxX && cueX < maxX && standardGhostX < maxX);

            if (isMovingTowardRail && (distG + e * distCue) > 0) {
              let hitY = (distG * cueY + e * distCue * standardGhostY) / (distG + e * distCue);
              if (hitY >= minY + r * 2.5 && hitY <= maxY - r * 2.5) {
                kickBouncePoint = { x: c.val, y: hitY };
              }
            }
          } else {
            let distCue = Math.abs(cueY - c.val);
            let distG = Math.abs(standardGhostY - c.val);
            let isMovingTowardRail = (c.val === minY && cueY > minY && standardGhostY > minY) || (c.val === maxY && cueY < maxY && standardGhostY < maxY);

            if (isMovingTowardRail && (distG + e * distCue) > 0) {
              let hitX = (distG * cueX + e * distCue * standardGhostX) / (distG + e * distCue);
              if (hitX >= minX + r * 2.5 && hitX <= maxX - r * 2.5) {
                kickBouncePoint = { x: hitX, y: c.val };
              }
            }
          }

          if (kickBouncePoint) {
            let toWallDist = Math.hypot(kickBouncePoint.x - cueX, kickBouncePoint.y - cueY);
            let wallToGDist = Math.hypot(standardGhostX - kickBouncePoint.x, standardGhostY - kickBouncePoint.y);
             
            if (toWallDist > r * 2 && wallToGDist > r * 2) {
              let wallToGDirX = (standardGhostX - kickBouncePoint.x) / wallToGDist;
              let wallToGDirY = (standardGhostY - kickBouncePoint.y) / wallToGDist;

              let cutAngle = (wallToGDirX * pDirX) + (wallToGDirY * pDirY);

              if (cutAngle > 0.28) {
                const isCueToWallBlocked = isPathBlocked(cueX, cueY, kickBouncePoint.x, kickBouncePoint.y, [0], activeBalls, r);
                const isWallToGhostBlocked = isPathBlocked(kickBouncePoint.x, kickBouncePoint.y, standardGhostX, standardGhostY, [0, b.num], activeBalls, r);
                const isTargetToPocketBlocked = isPathBlocked(bx, by, p.x, p.y, [b.num], activeBalls, r);

                if (!isCueToWallBlocked && !isWallToGhostBlocked && !isTargetToPocketBlocked) {
                  let totalKickDist = toWallDist + wallToGDist + pDist;
                  let kickPower = Math.min(80, Math.max(60, Math.round(56 + (totalKickDist / canvasH) * 22)));
                  let kickAngle = Math.atan2(kickBouncePoint.y - cueY, kickBouncePoint.x - cueX);

                  let kickDiffScore = (1 - cutAngle) * 0.40 + (totalKickDist / canvasH) * 0.45 + 0.22;

                  kickCandidates.push({
                    ball: b,
                    ballNum: b.num,
                    isCard: cardNums ? cardNums.includes(b.num) : false,
                    isBank: false,
                    isKick: true,
                    isTrick: false,
                    cueBouncePoint: kickBouncePoint,
                    cushionName: c.name,
                    pocketName: p.id,
                    pocket: p,
                    angle: kickAngle,
                    power: kickPower,
                    cutQuality: (cutAngle * 100).toFixed(0) + '%',
                    difficulty: kickDiffScore,
                    ghostX: standardGhostX,
                    ghostY: standardGhostY,
                    targetX: bx,
                    targetY: by,
                    pocketX: p.x,
                    pocketY: p.y
                  });
                }
              }
            }
          }
        }
      }

      // C. BANK SHOTS
      for (let pIdx = 0; pIdx < pockets.length; pIdx++) {
        const p = pockets[pIdx];
        if (p.isSide) continue;

        for (let cIdx = 0; cIdx < cushions.length; cIdx++) {
          const c = cushions[cIdx];
          let bouncePoint = null;

          if (c.axis === 'x') {
            let distP = Math.abs(p.x - c.val);
            let distB = Math.abs(bx - c.val);
            let isMovingTowardRail = (c.val === minX && bx > minX && p.x > minX) || (c.val === maxX && bx < maxX && p.x < maxX);

            if (isMovingTowardRail && (distP + e * distB) > 0) {
              let hitY = (distP * by + e * distB * p.y) / (distP + e * distB);
              if (hitY >= minY + r * 2.5 && hitY <= maxY - r * 2.5) {
                bouncePoint = { x: c.val, y: hitY };
              }
            }
          } else {
            let distP = Math.abs(p.y - c.val);
            let distB = Math.abs(by - c.val);
            let isMovingTowardRail = (c.val === minY && by > minY && p.y > minY) || (c.val === maxY && by < maxY && p.y < maxY);

            if (isMovingTowardRail && (distP + e * distB) > 0) {
              let hitX = (distP * bx + e * distB * p.x) / (distP + e * distB);
              if (hitX >= minX + r * 2.5 && hitX <= maxX - r * 2.5) {
                bouncePoint = { x: hitX, y: c.val };
              }
            }
          }

          if (bouncePoint) {
            let toBounceX = bouncePoint.x - bx;
            let toBounceY = bouncePoint.y - by;
            let toBounceDist = Math.hypot(toBounceX, toBounceY);
            if (toBounceDist < r * 3) continue;

            let dirBounceX = toBounceX / toBounceDist;
            let dirBounceY = toBounceY / toBounceDist;

            let ghostX = bx - (dirBounceX * r * 2);
            let ghostY = by - (dirBounceY * r * 2);

            let cdx = ghostX - cueX;
            let cdy = ghostY - cueY;
            let cDist = Math.hypot(cdx, cdy);
            if (cDist === 0) continue;

            let cDirX = cdx / cDist;
            let cDirY = cdy / cDist;

            let cutAngle = (cDirX * dirBounceX) + (cDirY * dirBounceY);

            if (cutAngle > 0.25) {
              const isCueBlocked = isPathBlocked(cueX, cueY, ghostX, ghostY, [0, b.num], activeBalls, r);
              const isTargetToWallBlocked = isPathBlocked(bx, by, bouncePoint.x, bouncePoint.y, [b.num], activeBalls, r);
              const isWallToPocketBlocked = isPathBlocked(bouncePoint.x, bouncePoint.y, p.x, p.y, [b.num], activeBalls, r);

              if (!isCueBlocked && !isTargetToWallBlocked && !isWallToPocketBlocked) {
                let totalBankDist = toBounceDist + Math.hypot(p.x - bouncePoint.x, p.y - bouncePoint.y);
                let bankPower = Math.min(76, Math.max(58, Math.round(54 + (totalBankDist / canvasH) * 22)));
                let finalBankAngle = Math.atan2(cdy, cdx);

                let bankDiffScore = (1 - cutAngle) * 0.40 + (totalBankDist / canvasH) * 0.35 + 0.15;

                bankCandidates.push({
                  ball: b,
                  ballNum: b.num,
                  isCard: cardNums ? cardNums.includes(b.num) : false,
                  isBank: true,
                  isKick: false,
                  isTrick: false,
                  bouncePoint: bouncePoint,
                  cushionName: c.name,
                  pocketName: p.id,
                  pocket: p,
                  angle: finalBankAngle,
                  power: bankPower,
                  cutQuality: (cutAngle * 100).toFixed(0) + '%',
                  difficulty: bankDiffScore,
                  ghostX: ghostX,
                  ghostY: ghostY,
                  targetX: bx,
                  targetY: by,
                  pocketX: p.x,
                  pocketY: p.y
                });
              }
            }
          }
        }
      }
    }

    const sortFn = (a, b) => {
      if (!inCardMode && b.ballNum !== a.ballNum) {
        return b.ballNum - a.ballNum;
      }
      return a.difficulty - b.difficulty;
    };

    directCandidates.sort(sortFn);
    bankCandidates.sort(sortFn);
    kickCandidates.sort(sortFn);

    const verifiedShots = [];

    for (let i = 0; i < Math.min(5, directCandidates.length); i++) {
      const s = directCandidates[i];
      const vResult = simulateVirtualShot(s.angle, s.power, s.ballNum);
      s.isScratch = vResult.cuePocketed;
      s.landingCue = vResult.finalCuePos;
      if (vResult.cuePocketed) s.difficulty += 999;
      if (!vResult.targetPocketed) s.difficulty += 250;
      verifiedShots.push(s);
    }

    for (let i = 0; i < Math.min(3, bankCandidates.length); i++) {
      const s = bankCandidates[i];
      const vResult = simulateVirtualShot(s.angle, s.power, s.ballNum);
      if (vResult.targetPocketed && !vResult.isDoubleKiss && !vResult.cuePocketed) {
        s.isScratch = false;
        s.landingCue = vResult.finalCuePos;
        verifiedShots.push(s);
      }
    }

    for (let i = 0; i < Math.min(3, kickCandidates.length); i++) {
      const s = kickCandidates[i];
      const vResult = simulateVirtualShot(s.angle, s.power, s.ballNum);
      if (vResult.targetPocketed && !vResult.cuePocketed) {
        s.isScratch = false;
        s.landingCue = vResult.finalCuePos;
        verifiedShots.push(s);
      }
    }

    if (verifiedShots.length === 0 && targetBalls.length > 0) {
      const b = targetBalls[0];
      const bx = b.x * canvasW;
      const by = b.y * canvasH;

      let nearestPocket = pockets[0];
      let minPDist = Infinity;
      for (let pIdx = 0; pIdx < pockets.length; pIdx++) {
        const p = pockets[pIdx];
        let dist = Math.hypot(p.x - bx, p.y - by);
        if (dist < minPDist) {
          minPDist = dist;
          nearestPocket = p;
        }
      }

      let pdx = nearestPocket.x - bx;
      let pdy = nearestPocket.y - by;
      let pDist = Math.hypot(pdx, pdy) || 1;
      let pDirX = pdx / pDist;
      let pDirY = pdy / pDist;
      let ghostX = bx - (pDirX * r * 2);
      let ghostY = by - (pDirY * r * 2);
      let fallbackAngle = Math.atan2(ghostY - cueY, ghostX - cueX);

      verifiedShots.push({
        ball: b,
        ballNum: b.num,
        isCard: cardNums ? cardNums.includes(b.num) : false,
        isBank: false,
        isKick: false,
        isTrick: false,
        isScratch: false,
        landingCue: null,
        pocketName: nearestPocket.id,
        pocket: nearestPocket,
        angle: fallbackAngle,
        power: 45,
        cutQuality: '50%',
        difficulty: 50,
        ghostX: ghostX,
        ghostY: ghostY,
        targetX: bx,
        targetY: by,
        pocketX: nearestPocket.x,
        pocketY: nearestPocket.y
      });
    }

    cachedShots = verifiedShots.sort((a, b) => {
      if (a.isScratch !== b.isScratch) return a.isScratch ? 1 : -1;
      if (!inCardMode && b.ballNum !== a.ballNum) {
        return b.ballNum - a.ballNum;
      }
      return a.difficulty - b.difficulty;
    });

    return cachedShots;
  }

  // 11. AUTO BALL-IN-HAND PLACER
  window.autoPlaceCueBall = function() {
    const pockets = getPockets();
    const r = getBallRadius();
    const railW = canvasW * ENGINE_TABLE.railInset;
    const minX = railW + r * 1.5, maxX = canvasW - railW - r * 1.5;
    const minY = railW + r * 1.5, maxY = canvasH - railW - r * 1.5;

    let activeBalls = (typeof balls !== 'undefined' ? balls : internalBalls).filter(b => b.num !== 0 && !b.pocketed);
    const cardNums = getMyCardNumbers();
    const inCardMode = isCardModeActive() && cardNums && cardNums.length > 0;

    let targets = activeBalls;
    if (inCardMode) {
      targets = activeBalls.filter(b => cardNums.includes(b.num));
      if (targets.length === 0) targets = activeBalls;
    } else {
      targets = activeBalls.slice().sort((a, b) => b.num - a.num);
    }

    let bestPlacement = null;
    let bestDist = Infinity;

    for (let bIdx = 0; bIdx < targets.length; bIdx++) {
      const b = targets[bIdx];
      let bx = b.x * canvasW;
      let by = b.y * canvasH;

      for (let pIdx = 0; pIdx < pockets.length; pIdx++) {
        const p = pockets[pIdx];
        if (p.isSide) continue;
        let pdx = p.x - bx;
        let pdy = p.y - by;
        let pDist = Math.hypot(pdx, pdy);
        if (pDist === 0) continue;

        let pDirX = pdx / pDist;
        let pDirY = pdy / pDist;

        let placeDist = Math.min(220, Math.max(120, pDist * 0.5));
        let testX = bx - (pDirX * (r * 2 + placeDist));
        let testY = by - (pDirY * (r * 2 + placeDist));

        if (testX >= minX && testX <= maxX && testY >= minY && testY <= maxY) {
          let hasOverlap = activeBalls.some(o => Math.hypot(o.x * canvasW - testX, o.y * canvasH - testY) < r * 2.2);
          if (!hasOverlap) {
            let isTargetBlocked = isPathBlocked(bx, by, p.x, p.y, [b.num], activeBalls, r);
            if (!isTargetBlocked && pDist < bestDist) {
              bestDist = pDist;
              bestPlacement = { x: testX, y: testY };
            }
          }
        }
      }
      if (bestPlacement && !inCardMode) break;
    }

    if (bestPlacement) {
      const rect = canvasEl.getBoundingClientRect();
      const clientX = rect.left + (bestPlacement.x / canvasW) * rect.width;
      const clientY = rect.top + (bestPlacement.y / canvasH) * rect.height;

      if (typeof window.updateCueBallPlacement === 'function') {
        window.updateCueBallPlacement({ clientX: clientX, clientY: clientY });
      }

      setTimeout(() => {
        if (typeof window.confirmCueBallPlacement === 'function') {
          window.confirmCueBallPlacement();
        }
        setTimeout(() => {
          currentShotIndex = 0;
          const shots = solveBestShots();
          if (shots.length > 0) window.lockAimToAngle(shots[0]);
        }, 150);
      }, 100);
    }
  };

  // 12. POWER SLIDER & ROTASI STIK REAL-TIME (STICK ALWAYS VISIBLE)
  window.setGamePower = function(percent) {
    const slider = document.querySelector('input[type="range"]') || document.querySelector('[class*="power"]') || document.getElementById('power-slider') || document.getElementById('power-seek');
    if (slider) {
      slider.value = percent;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  window.lockAimToAngle = function(shotObj) {
    const cue = (typeof balls !== 'undefined' ? balls.find(b => b.num === 0 && !b.pocketed) : null) || currentCue;
    if (!canvasEl || !cue || !shotObj) return;

    const angle = shotObj.angle;
    const power = shotObj.power || 48;
    simulatedLandingCue = shotObj.landingCue || null;

    const rect = canvasEl.getBoundingClientRect();
    const cueX = cue.x * canvasW;
    const cueY = cue.y * canvasH;

    const aimDist = 380;
    const targetCanvasX = cueX + Math.cos(angle) * aimDist;
    const targetCanvasY = cueY + Math.sin(angle) * aimDist;

    const clientX = rect.left + (targetCanvasX / canvasW) * rect.width;
    const clientY = rect.top + (targetCanvasY / canvasH) * rect.height;

    // Sinkronkan Global State Engine Game
    if (typeof window.aimAngle !== 'undefined') window.aimAngle = angle;
    if (typeof window.isAiming !== 'undefined') window.isAiming = true;
    if (typeof isAiming !== 'undefined') isAiming = true;

    if (typeof aimVector !== 'undefined') {
      aimVector.dx = Math.cos(angle) * aimDist;
      aimVector.dy = Math.sin(angle) * aimDist;
    }

    // Active-Hold PointerEvent
    const baseEvtProps = {
      clientX: clientX,
      clientY: clientY,
      pageX: clientX + window.scrollX,
      pageY: clientY + window.scrollY,
      pointerId: 1,
      pointerType: 'mouse',
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      view: window
    };

    const downEvt = new PointerEvent('pointerdown', baseEvtProps);
    const moveEvt = new PointerEvent('pointermove', baseEvtProps);

    canvasEl.dispatchEvent(downEvt);
    canvasEl.dispatchEvent(moveEvt);

    if (typeof window.updateAimFromPointer === 'function') {
      try { window.updateAimFromPointer(moveEvt); } catch (e) {}
    }

    window.setGamePower(power);

    if (typeof window.findTargetBall === 'function') {
      try { window.findTargetBall(cue, canvasW, canvasH, angle); } catch(e){}
    }
    if (typeof window.render === 'function') {
      try { window.render(); } catch(e){}
    }

    updateHUD();
  };

  // 13. EKSEKUSI TEMBAKAN INSTAN
  window.triggerShoot = function() {
    const shootBtn = document.getElementById('shoot-btn') || document.querySelector('[id*="shoot"]') || document.querySelector('button.shoot');

    lastHitData = null;
    cachedShots = [];
    currentShotIndex = 0;
    simulatedLandingCue = null;

    if (typeof window.onShootClick === 'function') {
      try { window.onShootClick(); return; } catch(e){}
    }

    if (shootBtn && !shootBtn.disabled) {
      shootBtn.click();
    } else if (typeof window.commitAndRunShot === 'function' && typeof aimVector !== 'undefined') {
      const angle = Math.atan2(aimVector.dy, aimVector.dx);
      const power = 0.5;
      window.commitAndRunShot(angle, power);
    }
  };

  function adjustAngle(deltaRad) {
    if (cachedShots.length > 0) {
      let currentShot = cachedShots[currentShotIndex] || cachedShots[0];
      currentShot.angle += deltaRad;
      window.lockAimToAngle(currentShot);
    }
  }

  // 14. FORENSIC AUDITOR
  const origRunPhysics = window.runPhysicsSimulation;
  if (!window._blackboxIntegrated && typeof origRunPhysics === 'function') {
    window._blackboxIntegrated = true;

    window.runPhysicsSimulation = function() {
      const w = canvas.width, h = canvas.height;
      const pockets = (typeof getPocketPositions === 'function') ? getPocketPositions(w, h) : [];
      const activeTargets = balls.filter(b => b.num !== 0 && !b.pocketed);

      const shotLog = { minDistanceToPockets: {} };
      activeTargets.forEach(b => {
        shotLog.minDistanceToPockets[b.num] = { minDist: Infinity, nearestPocket: null };
      });

      const trackerInterval = setInterval(() => {
        if (!simulating) {
          clearInterval(trackerInterval);
          return;
        }

        balls.forEach(b => {
          if (b.num === 0 || b.pocketed) return;
          const bx = b.x * w, by = b.y * h;

          pockets.forEach((p, pIdx) => {
            const dist = Math.hypot(bx - p.x, by - p.y);
            const currentRec = shotLog.minDistanceToPockets[b.num];
            if (currentRec && dist < currentRec.minDist) {
              currentRec.minDist = dist;
              currentRec.nearestPocket = { index: pIdx, x: p.x, y: p.y, r: p.r };
            }
          });
        });
      }, 16);

      const promise = origRunPhysics.apply(this, arguments);

      promise.then(() => {
        clearInterval(trackerInterval);
        const pocketedBalls = (typeof shotAccum !== 'undefined' && shotAccum) ? shotAccum.pocketed : [];
        const isScratch = (typeof shotAccum !== 'undefined' && shotAccum) ? shotAccum.cueBallPocketed : false;

        if (pocketedBalls.length > 0 || isScratch) {
          console.group('%c🎯 [AUDIT TEMBAKAN]', 'color: #00ffaa; font-weight: bold;');
          if (pocketedBalls.length > 0) console.log('💥 Bola Masuk: #' + pocketedBalls.join(', #'));
          if (isScratch) console.log('%c⚠️ FOUL: Bola Putih Masuk Lubang (Scratch)!', 'color: #ff0055; font-weight: bold;');
          console.groupEnd();
        }
      });

      return promise;
    };
  }

  // 15. MODERN COMPACT 2-ROW HUD
  function createDraggableHUD() {
    const hud = document.createElement('div');
    hud.id = 'aim-hud-pc';
    hud.style.cssText = 'position:fixed; top:12px; right:15px; z-index:999999; background:rgba(10,16,28,0.95); backdrop-filter:blur(10px); border:1px solid rgba(0,255,170,0.35); border-radius:14px; padding:6px 10px; color:#fff; font-family:monospace,sans-serif; font-size:11px; box-shadow:0 4px 20px rgba(0,0,0,0.6); user-select:none; cursor:move; display:flex; flex-direction:column; gap:4px; max-width:280px; box-sizing:border-box;';

    hud.innerHTML = '<div id="hud-status" style="display:flex; flex-direction:column; gap:4px;"><span>🎯 <b style="color:#00ffaa;">Auto-Aim Master V16.0</b></span></div>';

    document.body.appendChild(hud);

    let isDragging = false, startX, startY, initLeft, initTop;
    hud.onmousedown = (e) => {
      if (e.target.id === 'mode-pill-badge') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = hud.getBoundingClientRect();
      initLeft = rect.left;
      initTop = rect.top;
      hud.style.right = 'auto';
      hud.style.left = initLeft + 'px';
      hud.style.top = initTop + 'px';
      e.preventDefault();
    };

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      hud.style.left = (initLeft + (e.clientX - startX)) + 'px';
      hud.style.top = (initTop + (e.clientY - startY)) + 'px';
    });

    window.addEventListener('mouseup', () => { isDragging = false; });
  }

  function getModeBadgeHTML() {
    let modeText = '🎯AUTO';
    let modeColor = '#00ffaa';
    let modeBg = '#162b3d';

    if (targetMode === 'CARD') { modeText = '🃏KARTU'; modeColor = '#ff9800'; modeBg = '#3d2b16'; }
    else if (targetMode === 'ALL') { modeText = '🎱ALL'; modeColor = '#b388ff'; modeBg = '#22163d'; }
    else if (targetMode === 'TRICK') { modeText = '✨TRICK'; modeColor = '#ff00ff'; modeBg = '#3d163d'; }

    return '<span id="mode-pill-badge" style="background:' + modeBg + '; color:' + modeColor + '; border:1px solid ' + modeColor + '88; border-radius:6px; padding:1px 6px; cursor:pointer; font-weight:bold; font-size:10px;">' + modeText + '</span>';
  }

  function updateHUD() {
    const statusEl = document.getElementById('hud-status');
    const cardNums = getMyCardNumbers();
    const modeBadge = getModeBadgeHTML();

    let currentShots = cachedShots;
    if (!currentShots || currentShots.length === 0) {
      currentShots = solveBestShots();
    }

    if (statusEl && currentShots && currentShots.length > 0) {
      const s = currentShots[currentShotIndex] || currentShots[0];
      const isMyCardText = s.isCard ? '<span style="color:#ffeb3b; font-weight:bold;">[🃏]</span>' : '';
      const isBankText = s.isBank ? '<span style="color:#00ffff; font-weight:bold;">[🔄BANK]</span>' : '';
      const isKickText = s.isKick ? '<span style="color:#e040fb; font-weight:bold;">[📐KICK]</span>' : '';
      const isBreakText = s.isBreak ? '<span style="color:#ff00ff; font-weight:bold;">[💥BREAK]</span>' : '';
      const isTrickText = s.isTrick ? '<span style="color:#ff00ff; font-weight:bold;">[✨' + s.trickTag + ']</span>' : '';
      const isScratchWarning = s.isScratch ? '<span style="color:#ff0055; font-weight:bold;">[⚠️SCRATCH]</span>' : '';
      const countIndexInfo = currentShots.length > 1 ? '<span style="color:#888; font-size:10px;">(' + (currentShotIndex + 1) + '/' + currentShots.length + ')</span>' : '';
      
      const cardsChip = (isCardModeActive() && cardNums && cardNums.length > 0)
        ? '<span style="color:#bbb; font-size:9px; background:#222; padding:1px 4px; border-radius:4px;">🃏[' + cardNums.join(',') + ']</span>'
        : '';

      statusEl.innerHTML = 
        '<div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">' +
          '<div style="display:flex; align-items:center; gap:5px;">' +
            modeBadge +
            '<span>🎱<b style="color:#00ffaa;">#' + s.ballNum + '</b></span>' +
            isMyCardText + isBankText + isKickText + isBreakText + isTrickText + isScratchWarning +
          '</div>' +
          countIndexInfo +
        '</div>' +
        '<div style="display:flex; align-items:center; justify-content:space-between; gap:6px; font-size:10px; border-top:1px solid #ffffff15; padding-top:3px;">' +
          '<span style="color:#aaa;">📍' + s.pocketName + '</span>' +
          '<div style="display:flex; align-items:center; gap:6px;">' +
            '<span>⚡<b style="color:#ff5555;">' + s.power + '%</b></span>' +
            '<span>🎯<b style="color:#00ff66;">' + s.cutQuality + '</b></span>' +
            cardsChip +
          '</div>' +
        '</div>';
    } else if (statusEl) {
      statusEl.innerHTML = 
        '<div style="display:flex; align-items:center; gap:6px;">' +
          modeBadge + ' <span style="color:#aaa;">🎯 Auto-Aim [No Shot]</span>' +
        '</div>';
    }

    const badgeEl = document.getElementById('mode-pill-badge');
    if (badgeEl) {
      badgeEl.onclick = (e) => {
        e.stopPropagation();
        if (targetMode === 'AUTO') targetMode = 'ALL';
        else if (targetMode === 'ALL') targetMode = 'CARD';
        else if (targetMode === 'CARD') targetMode = 'TRICK';
        else targetMode = 'AUTO';
        currentShotIndex = 0;
        solveBestShots();
        updateHUD();
      };
    }
  }

  createDraggableHUD();

  // 16. EVENT LISTENERS
  if (canvasEl) {
    canvasEl.addEventListener('click', (e) => {
      const rect = canvasEl.getBoundingClientRect();
      const clickX = (e.clientX - rect.left) / rect.width * canvasW;
      const clickY = (e.clientY - rect.top) / rect.height * canvasH;

      const r = getBallRadius() * 3.0;
      const activeBalls = (typeof balls !== 'undefined' ? balls : internalBalls).filter(b => b.num !== 0 && !b.pocketed);

      const clickedBall = activeBalls.find(b => Math.hypot(b.x * canvasW - clickX, b.y * canvasH - clickY) < r);

      if (clickedBall) {
        setTimeout(() => {
          const shots = solveBestShots().filter(s => s.ballNum === clickedBall.num);
          if (shots.length > 0) {
            currentShotIndex = 0;
            window.lockAimToAngle(shots[0]);
          }
        }, 0);
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const isSpace = (e.code === 'Space' || key === 'enter');

    if (isSpace) e.preventDefault();

    setTimeout(() => {
      if (key === 'a') {
        targetMode = 'AUTO';
        currentShotIndex = 0;
        const shots = solveBestShots();
        if (shots.length > 0) {
          window.lockAimToAngle(shots[0]);
        }
      } else if (key === 't') {
        targetMode = 'TRICK';
        currentShotIndex = 0;
        console.log('%c✨ [TRICKSHOT SOLVER] Memindai peluang Multi-Rail 4-6 Ban & Multi-Pot...', 'color: #ff00ff; font-weight: bold;');
        const tricks = solveAllTrickshots();
        if (tricks.length > 0) {
          cachedShots = tricks;
          window.lockAimToAngle(cachedShots[0]);
          console.log('%c👑 Ditemukan ' + tricks.length + ' Trickshot / Multi-Rail 100% Masuk!', 'color: #00ffaa; font-weight: bold;');
        } else {
          console.log('%c⚠️ Tidak ada celah Trickshot bersih di giliran ini.', 'color: #ffaa00;');
          targetMode = 'AUTO';
          solveBestShots();
        }
        updateHUD();
      } else if (key === 'b') {
        window.autoPlaceCueBall();
      } else if (key === 'n') {
        const shots = (targetMode === 'TRICK') ? cachedShots : solveBestShots();
        if (shots.length > 0) {
          currentShotIndex = (currentShotIndex + 1) % shots.length;
          window.lockAimToAngle(shots[currentShotIndex]);
        }
      } else if (isSpace) {
        window.triggerShoot();
      } else if (key === 'm') {
        if (targetMode === 'AUTO') targetMode = 'ALL';
        else if (targetMode === 'ALL') targetMode = 'CARD';
        else targetMode = 'AUTO';
        currentShotIndex = 0;
        solveBestShots();
        if (cachedShots.length > 0) window.lockAimToAngle(cachedShots[0]);
        updateHUD();
      } else if (key === 'q') {
        adjustAngle(-0.0018);
      } else if (key === 'e') {
        adjustAngle(0.0018);
      } else if (key === 'h') {
        const hud = document.getElementById('aim-hud-pc');
        if (hud) {
          hudVisible = !hudVisible;
          hud.style.display = hudVisible ? 'flex' : 'none';
        }
      }
    }, 0);
  });

  console.log('%c👑 Auto-Aim Master V16.0 (Extreme Multi-Rail & God Shot) AKTIF!', 'color: #00ffaa; font-size: 14px; font-weight: bold;');
})();