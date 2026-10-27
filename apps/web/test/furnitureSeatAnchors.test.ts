import { describe, expect, it } from 'vitest';
import { OFFICE_RESOURCES } from '../src/office/scene/interior/resourceRegistry';
import { ROOM_RELOCATIONS } from '../src/office/scene/interior/roomRelocation';
import { ARMCHAIR_SEAT_BLUEPRINT, GUEST_CHAIR_SEAT_BLUEPRINT, OFFICE_CHAIR_SEAT_BLUEPRINT, SOFA_SEAT_BLUEPRINT } from '../src/office/scene/interior/furnitureSeatBlueprint';
import { TEAM_POD_SEAT } from '../src/office/scene/interior/spatialBlueprints';
import { seatApproach } from '../src/office/scene/movement/navGraph';

const resource = (id: string) => {
  const found = OFFICE_RESOURCES.find(entry => entry.id === id);
  if (!found) throw new Error(`Missing fixture seat ${id}`);
  return found;
};

describe('furniture seat dimensions and anchors', () => {
  it('keeps office chair mesh dimensions, surface height, and seat-front anchor in agreement', () => {
    expect(OFFICE_CHAIR_SEAT_BLUEPRINT.cushionCenter[1] + OFFICE_CHAIR_SEAT_BLUEPRINT.cushionSize[1] / 2)
      .toBeCloseTo(0.46, 6);
    expect(OFFICE_CHAIR_SEAT_BLUEPRINT.cushionHeight).toBe(0.46);
    expect(OFFICE_CHAIR_SEAT_BLUEPRINT.cushionSize[0]).toBe(0.5);
    expect(OFFICE_CHAIR_SEAT_BLUEPRINT.cushionSize[2]).toBe(0.46);
    expect(OFFICE_CHAIR_SEAT_BLUEPRINT.armOuterWidth).toBe(0.64);
    expect(OFFICE_CHAIR_SEAT_BLUEPRINT.armPadTop).toBe(0.71);
    expect(OFFICE_CHAIR_SEAT_BLUEPRINT.baseDiameter).toBe(0.72);
    expect(OFFICE_CHAIR_SEAT_BLUEPRINT.cushionHeight + OFFICE_CHAIR_SEAT_BLUEPRINT.taskBackHeight).toBeCloseTo(1.12, 6);
    expect(OFFICE_CHAIR_SEAT_BLUEPRINT.cushionHeight + OFFICE_CHAIR_SEAT_BLUEPRINT.executiveBackHeight).toBeCloseTo(1.30, 6);
    expect(resource('qa.station-1').interaction.seatHeight).toBe(OFFICE_CHAIR_SEAT_BLUEPRINT.cushionHeight);
    expect(resource('qa.station-1').interaction.seatFront).toBeCloseTo(0.225, 6);
  });

  it('keeps desk anchors and pod input reach aligned with the seats', () => {
    const deskSeat = resource('qa.station-1');
    expect(deskSeat.position[2] - 10.7 - ROOM_RELOCATIONS.qa![1]).toBeCloseTo(0.62, 6);
    const yaw = TEAM_POD_SEAT.chairRotationY;
    const rootX = TEAM_POD_SEAT.chairPosition[0] + Math.sin(yaw) * TEAM_POD_SEAT.seatForward;
    const rootZ = TEAM_POD_SEAT.chairPosition[1] + Math.cos(yaw) * TEAM_POD_SEAT.seatForward;
    expect(rootX).toBeCloseTo(rootZ, 6);
    expect(Math.hypot(rootX - TEAM_POD_SEAT.keyboardPosition[0], rootZ - TEAM_POD_SEAT.keyboardPosition[2])).toBeCloseTo(.3986, 4);
  });

  it('uses actual upholstery cushion tops and front edges for semantic seat contracts', () => {
    expect(SOFA_SEAT_BLUEPRINT.seatCenters[0]!.y + SOFA_SEAT_BLUEPRINT.cushionSize[1] / 2).toBeCloseTo(0.43, 6);
    expect(ARMCHAIR_SEAT_BLUEPRINT.seatCenter.y + ARMCHAIR_SEAT_BLUEPRINT.cushionSize[1] / 2).toBeCloseTo(0.45, 6);
    expect(resource('lounge.sofa-1').interaction.seatHeight).toBe(SOFA_SEAT_BLUEPRINT.cushionHeight);
    expect(resource('lounge.sofa-1').interaction.seatFront).toBeCloseTo(0.235, 6);
    expect(seatApproach(resource('lounge.sofa-1')).seatFront).toBeCloseTo(0.235, 6);
    expect(resource('lounge.armchair-1').interaction.seatHeight).toBe(ARMCHAIR_SEAT_BLUEPRINT.cushionHeight);
    expect(resource('lounge.armchair-1').interaction.seatFront).toBeCloseTo(0.225, 6);
    expect(resource('executive.lounge-sofa-1').interaction.seatHeight).toBe(0.43);
    expect(resource('executive.lounge-sofa-1').interaction.seatFront).toBeCloseTo(0.31, 6);
  });

  it('aligns meeting and guest cushions while retaining the elevated barstools', () => {
    expect(GUEST_CHAIR_SEAT_BLUEPRINT.cushionHeight).toBe(0.46);
    expect(GUEST_CHAIR_SEAT_BLUEPRINT.cushionCenter[1] + GUEST_CHAIR_SEAT_BLUEPRINT.cushionSize[1] / 2).toBeCloseTo(0.46, 6);
    expect(resource('executive.guest-1').interaction.seatHeight).toBe(GUEST_CHAIR_SEAT_BLUEPRINT.cushionHeight);
    expect(resource('executive.guest-1').interaction.seatFront).toBeCloseTo(0.22, 6);
    expect(resource('lounge.barstool-1').interaction.seatHeight).toBe(0.76);
    expect(resource('meeting-a.seat-1').interaction.seatHeight).toBe(OFFICE_CHAIR_SEAT_BLUEPRINT.cushionHeight);
    expect(resource('meeting-a.seat-1').interaction.seatFront).toBeCloseTo(0.205, 6);
  });
});
