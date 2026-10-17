import { SenderGate } from './sender-gate';

describe('SenderGate', () => {
  const opts = { perSender: 3, globalSoftLimit: 5, noticeEveryMs: 1000 };

  it('admits up to perSender updates of one sender and refuses the rest', () => {
    const g = new SenderGate(opts);
    expect([1, 2, 3, 4, 5].map(() => g.enter('a').admitted)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(g.inFlight).toBe(3);
  });

  it('is per sender: another sender is unaffected by a full one', () => {
    const g = new SenderGate(opts);
    for (let i = 0; i < 10; i++) g.enter('a');
    expect(g.enter('b').admitted).toBe(true);
  });

  it('leave() frees a slot, and over-leaving is harmless', () => {
    const g = new SenderGate(opts);
    g.enter('a');
    g.enter('a');
    g.enter('a');
    expect(g.enter('a').admitted).toBe(false);
    g.leave('a');
    expect(g.enter('a').admitted).toBe(true);
    for (let i = 0; i < 10; i++) g.leave('a');
    g.leave('never-entered');
    expect(g.inFlight).toBe(0);
    expect(g.enter('a').admitted).toBe(true);
  });

  it('when the bot is overloaded, a sender who already has one in flight is not queued further', () => {
    const g = new SenderGate(opts); // soft limit 5
    for (const k of ['a', 'b', 'c', 'd', 'e']) expect(g.enter(k).admitted).toBe(true);
    expect(g.inFlight).toBe(5);
    expect(g.enter('a').admitted).toBe(false); // already has one: refused
    expect(g.enter('new').admitted).toBe(true); // a sender with nothing in flight is still served
  });

  it('the "still busy" notice is throttled per sender', () => {
    let t = 0;
    const g = new SenderGate(opts, () => t);
    for (let i = 0; i < 3; i++) g.enter('a');
    const first = g.enter('a');
    const second = g.enter('a');
    expect(first).toEqual({ admitted: false, notify: true });
    expect(second).toEqual({ admitted: false, notify: false });
    t = 1500;
    expect(g.enter('a')).toEqual({ admitted: false, notify: true });
  });
});
