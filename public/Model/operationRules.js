const workLineCycle = { mesa: 'maquinas', maquinas: 'embalaje', embalaje: 'mesa' };
const positionGroupCycle = { A: 'B', B: 'C', C: 'A' };

export function nextWorkLine(line) {
  return workLineCycle[line] || null;
}

export function nextPositionGroup(group) {
  return positionGroupCycle[group] || null;
}

export function returnLineAfterBreak(previousLine) {
  return previousLine && !['bano', 'colacion'].includes(previousLine) ? previousLine : 'unassigned';
}

export function statusForWorkLine(line) {
  return line === 'colacion' || line === 'bano' ? 'break' : line === 'unassigned' ? 'available' : 'assigned';
}
