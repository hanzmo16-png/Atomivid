import unittest
import numpy as np
from sequence_pixels import composite

class Pixels(unittest.TestCase):
    def setUp(self):
        self.s=np.full((4,4,3),.5,np.float32)
        self.p=np.full((4,4,3),.2,np.float32)
        self.room=np.full((4,4,3),.1,np.float32)
        self.g=np.ones_like(self.s)
        self.b=np.zeros_like(self.s)
    def test_interior_is_exact_frozen_grade(self):
        self.g *= .8
        out=composite(self.s,self.p,np.ones((4,4)),self.room,self.g,self.b)
        np.testing.assert_array_equal(out,np.clip(self.s*self.g+self.b,0,1))
    def test_background_and_source_geometry_unchanged(self):
        out=composite(self.s,self.p,np.zeros((4,4)),self.room,self.g,self.b)
        np.testing.assert_array_equal(out,self.p)
    def test_each_world_has_independent_light_without_ramp(self):
        a=np.ones((4,4))
        dark=composite(self.s,self.p,a,self.room,self.g*.5,self.b)
        day=composite(self.s,self.p,a,self.room,self.g,self.b)
        np.testing.assert_array_equal(day,self.s)
        np.testing.assert_array_equal(dark,self.s*.5)
    def test_edge_room_decontamination(self):
        out=composite(self.s,self.p,np.full((4,4),.5),self.room,self.g,self.b)
        np.testing.assert_allclose(out,.55,atol=1e-6)
    def test_malformed_look_and_matte_block(self):
        for alpha in (np.full((4,4),np.nan),np.full((4,4),2),np.zeros((3,4))):
            with self.assertRaises(ValueError):
                composite(self.s,self.p,alpha,self.room,self.g,self.b)
        with self.assertRaises(ValueError):
            composite(self.s,self.p,np.ones((4,4)),self.room,self.g*np.nan,self.b)

if __name__=='__main__': unittest.main()
