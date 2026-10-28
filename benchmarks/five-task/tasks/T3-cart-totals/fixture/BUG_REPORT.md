# Bug report: checkout totals are wrong

Customer cart (tax rate 8.25%):

| SKU | Unit price | Qty | Taxable |
| --- | --- | --- | --- |
| book | $12.99 | 3 | no |
| lamp | $24.50 | 2 | yes |

Expected subtotal $87.97, tax $4.04, total $92.01. Checkout shows tax $2.02 and total $89.99.

Also reported:
- A 10% coupon on a $0.11 cart gives a discount of 2¢; it should be 1¢. Discounts and tax round half up to the nearest cent.
- A $5.00 fixed coupon on a $3.00 cart produces a negative total; the total should be $0.00 and the discount $3.00.

Please fix the root causes (there may be more than one file involved) and add regression tests for these cases.
