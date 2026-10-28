import unittest

from stats import mean, median, mode, variance


class StatsTest(unittest.TestCase):
    def test_mean(self):
        self.assertEqual(mean([1, 2, 3, 4]), 2.5)

    def test_median_odd_unsorted(self):
        self.assertEqual(median([9, 1, 5]), 5)

    def test_median_even(self):
        self.assertEqual(median([3, 1, 4, 2]), 2.5)

    def test_variance(self):
        self.assertAlmostEqual(variance([2, 4, 4, 4, 5, 5, 7, 9]), 4.0)

    def test_mode_tie_prefers_smallest(self):
        self.assertEqual(mode([3, 1, 3, 1, 2]), 1)

    def test_empty_inputs_raise(self):
        for function in (mean, median, mode, variance):
            with self.assertRaises(ValueError):
                function([])


if __name__ == "__main__":
    unittest.main()
