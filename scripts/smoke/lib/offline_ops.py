"""Генератор офлайн-очереди для смоука этапа 5: те же правила расчёта, что у кассы (цена × кол-во − скидки)."""
import json, sys, uuid
from decimal import Decimal as D, ROUND_HALF_UP

def money(x): return D(x).quantize(D('0.01'), ROUND_HALF_UP)

def sale(prefix, n, shift, member, lines, at, disc_amount=None, customer=None, payments=None, total=None):
    gross = [money(D(l['price']) * D(l['qty'])) for l in lines]
    s = sum(gross, D(0))
    d = money(disc_amount) if disc_amount else D(0)
    tot = s - d if total is None else D(total)
    p = {
        'number': f'{prefix}-{n:06d}', 'createdAt': at, 'shiftId': shift, 'lines': lines, 'total': str(tot),
        'payments': payments or [{'method': 'cash', 'amount': str(tot)}],
    }
    if disc_amount: p['receiptDiscountAmount'] = str(disc_amount)
    if customer: p['customerId'] = customer
    return {'id': str(uuid.uuid4()), 'type': 'sale', 'at': at, 'membershipId': member, 'payload': p}

if __name__ == '__main__':
    cfg = json.loads(sys.argv[1])
    prefix, member, A, B, at = cfg['prefix'], cfg['member'], cfg['A'], cfg['B'], cfg['at']
    shift = str(uuid.uuid4())
    ops = [{'id': shift, 'type': 'shift_open', 'at': at, 'membershipId': member, 'payload': {'cash': {'KGS': '0', 'USD': '0'}}}]
    for i in range(1, 51):
        lines = [{'productId': A, 'qty': '1', 'price': cfg['priceA']}] if i % 2 else [{'productId': A, 'qty': '1', 'price': cfg['priceA']}, {'productId': B, 'qty': '2', 'price': cfg['priceB']}]
        ops.append(sale(prefix, i, shift, member, lines, at, disc_amount='10' if i == 7 else None))
    for k, o in enumerate(ops, start=cfg.get('startSeq', 1)): o['seq'] = k
    print(json.dumps({'shift': shift, 'ops': ops}))
